"""Tunes her small brain on examples of her own way of doing things.

What this makes is a LoRA adapter: a small file of adjustments laid over the model's
weights, which leaves the model file itself untouched. The examples come from a larger
model answering as her through the real app (see ``npm run eval -- --lessons``); only
answers that passed their lesson's checks are in the file this reads.

Each line of the examples file is one conversation exactly as the model reads it::

    {"id": "...", "text": "<|im_start|>system\\n...", "spans": [[start, end], ...]}

``spans`` mark, in characters, the parts she wrote in answer to the last thing the user
said. Only those are learned from; her instructions, the user's words and what tools
returned are read but never imitated.

Run it with the Python that has torch (the designed-voice environment) and the newer
libraries beside it::

    PYTHONPATH=~/.local/share/ai-chan-train/lib \\
      ~/.local/share/ai-chan/voice-env/bin/python train/lora.py \\
      --base ~/.local/share/ai-chan-train/Qwen3.5-4B --data lessons.jsonl --out out/

It will not start while a game has the graphics card, and it stops and saves if one is
started: run it again with the same arguments and it carries on from where it stopped.
"""

# torch, transformers and peft are not installed where the type checker runs (they live
# in the voice environment), and almost everything they return is untyped. Those reports
# would bury the ones worth reading, so they are off for this file only.
# pyright: reportMissingImports=false, reportAny=false, reportExplicitAny=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false
# pyright: reportUnknownArgumentType=false, reportUnknownParameterType=false
# pyright: reportUnusedCallResult=false, reportMissingTypeStubs=false

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

IGNORE = -100
"""The label that tells the loss to skip a token."""

GAME_MARKS = ("steamapps/common/", "steamapps\\common\\", "gamescope", "-shipping")
"""How a game shows among the programs holding the card; ``.exe`` is checked apart."""

# Every weight matrix inside a layer: both kinds of attention this model has, and the
# feed-forward part. The names are the model's own; each maps to one tensor in the
# model file she runs, which is what lets the adapter be laid over it.
TARGETS = (
    "q_proj",
    "k_proj",
    "v_proj",
    "o_proj",
    "in_proj_qkv",
    "in_proj_z",
    "out_proj",
    "gate_proj",
    "up_proj",
    "down_proj",
)


@dataclass(frozen=True)
class Example:
    """One conversation and which characters of it are hers to learn from."""

    id: str
    text: str
    spans: tuple[tuple[int, int], ...]


@dataclass
class Settings:
    """Everything that decides how the tuning comes out; saved beside the adapter."""

    base: str
    data: str
    out: str
    epochs: float = 2.0
    rank: int = 16
    alpha: int = 32
    dropout: float = 0.05
    lr: float = 1e-4
    warmup: float = 0.06
    accumulate: int = 8
    max_tokens: int = 12288
    held_out: float = 0.05
    seed: int = 7
    device: str = "cuda"
    limit: int = 0
    steps: int = 0
    qlora: bool = False
    mode: str = "sft"
    convert_gguf: str = ""
    embedder_data: str = ""
    embedder_out: str = ""
    force: bool = False


def read_examples(path: Path) -> list[Example]:
    """Reads the examples file, refusing lines that are not in the form described above."""
    examples: list[Example] = []
    with path.open(encoding="utf-8") as lines:
        for number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            row: dict[str, Any] = json.loads(line)
            text = row.get("text")
            spans = row.get("spans")
            if not isinstance(text, str) or not isinstance(spans, list) or not spans:
                message = f"{path}:{number}: needs a text and at least one span"
                raise ValueError(message)
            pairs: list[tuple[int, int]] = []
            for span in spans:
                start, end = int(span[0]), int(span[1])
                if not 0 <= start < end <= len(text):
                    message = f"{path}:{number}: span {start}-{end} is outside the text"
                    raise ValueError(message)
                pairs.append((start, end))
            examples.append(Example(str(row.get("id", number)), text, tuple(pairs)))
    return examples


def labels_for(
    offsets: list[tuple[int, int]], ids: list[int], spans: tuple[tuple[int, int], ...]
) -> list[int]:
    """Keeps a token's id as its label when the token lies inside a span, else skips it.

    A token counts as inside when it starts inside: the tokens that open a span (the
    first word she wrote) are learned, and the ones just before it are not.
    """
    labels: list[int] = []
    for (start, end), token in zip(offsets, ids, strict=True):
        inside = end > start and any(low <= start < high for low, high in spans)
        labels.append(token if inside else IGNORE)
    return labels


LAUNCHER_MARKS = (
    b"SteamAppId=",
    b"SteamGameId=",
    b"LUTRIS_GAME_UUID=",
    b"HEROIC_APP_NAME=",
)
"""What a game launcher sets for the games it starts, and for nothing else."""


def is_game(pid: int | None, name: str, proc: Path | None = None) -> bool:
    """Tells whether a program holding the card is a game.

    The same rules as the app's own watch (``src/core/cardWatch.ts``): its name, where
    its program file lives, and what its launcher started it with. A native game is
    named by the card only as it was started ("./Civ7_linux_Vulkan"), which says nothing.
    """
    lowered = name.lower()
    if lowered.endswith((".exe", ".x86_64")) or any(
        mark in lowered for mark in GAME_MARKS
    ):
        return True
    if pid is None:
        return False
    proc = proc or Path("/proc")
    try:
        exe = str((proc / str(pid) / "exe").readlink()).lower()
    except OSError:
        exe = ""
    if any(mark in exe for mark in GAME_MARKS):
        return True
    try:
        started = (proc / str(pid) / "environ").read_bytes().split(b"\0")
    except OSError:
        return False
    return any(
        entry.startswith(mark) and len(entry) > len(mark)
        for entry in started
        for mark in LAUNCHER_MARKS
    )


def game_on_card() -> str | None:
    """Names a game holding the graphics card, or None. None too when it cannot be asked."""
    try:
        listing = subprocess.run(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,process_name",
                "--format=csv,noheader",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in listing.splitlines():
        first, _, rest = line.partition(",")
        name = rest.strip()
        pid = int(first) if first.strip().isdigit() else None
        if name and is_game(pid, name):
            return name.replace("\\", "/").rsplit("/", maxsplit=1)[-1]
    return None


def fingerprint(settings: Settings) -> str:
    """Names a run by what it learns from and how, so a different run is not carried on.

    The step a run stopped at only means something for the same examples in the same
    order: with other data or another seed it would point into a different shuffle, and
    examples held out before could be learned from.
    """
    digest = hashlib.sha256(Path(settings.data).read_bytes())
    kept = (
        settings.base,
        settings.epochs,
        settings.rank,
        settings.alpha,
        settings.accumulate,
        settings.max_tokens,
        settings.held_out,
        settings.seed,
        settings.limit,
    )
    digest.update(repr(kept).encode())
    return digest.hexdigest()[:16]


def split(
    examples: list[Example], held_out: float, seed: int
) -> tuple[list[Example], list[Example]]:
    """Sets a share of the examples aside, the same ones every time for a seed."""
    order = list(examples)
    random.Random(seed).shuffle(order)
    kept_back = max(1, round(len(order) * held_out)) if len(order) >= 20 else 0
    return order[kept_back:], order[:kept_back]


def rate_at(step: int, total: int, peak: float, warmup: float) -> float:
    """Learning rate for a step: a short climb, then a cosine fall to a tenth of the peak."""
    climb = max(1, round(total * warmup))
    if step < climb:
        return peak * (step + 1) / climb
    progress = (step - climb) / max(1, total - climb)
    return peak * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, progress))))


def parse(argv: list[str]) -> Settings:
    parser = argparse.ArgumentParser(
        description=(__doc__ or "").split("\n", maxsplit=1)[0]
    )
    parser.add_argument(
        "--base", required=True, help="folder of the original model weights"
    )
    parser.add_argument("--data", required=True, help="the examples file (JSON lines)")
    parser.add_argument(
        "--out", required=True, help="folder for the adapter and its log"
    )
    parser.add_argument("--epochs", type=float, default=Settings.epochs)
    parser.add_argument("--rank", type=int, default=Settings.rank)
    parser.add_argument("--alpha", type=int, default=Settings.alpha)
    parser.add_argument("--dropout", type=float, default=Settings.dropout)
    parser.add_argument("--lr", type=float, default=Settings.lr)
    parser.add_argument("--accumulate", type=int, default=Settings.accumulate)
    parser.add_argument("--max-tokens", type=int, default=Settings.max_tokens)
    parser.add_argument("--held-out", type=float, default=Settings.held_out)
    parser.add_argument("--seed", type=int, default=Settings.seed)
    parser.add_argument("--device", default=Settings.device, choices=["cuda", "cpu"])
    parser.add_argument(
        "--limit", type=int, default=0, help="use only this many examples (a trial)"
    )
    parser.add_argument(
        "--steps",
        type=int,
        default=0,
        help="optional cap on optimizer updates for overnight window budgeting",
    )
    parser.add_argument(
        "--qlora",
        action="store_true",
        help="enable 4-bit NF4 QLoRA quantization when bitsandbytes is installed",
    )
    parser.add_argument(
        "--mode",
        default="sft",
        choices=["sft", "preference", "embedder"],
        help="distillation training target mode",
    )
    parser.add_argument(
        "--convert-gguf",
        default="",
        help="path to convert_lora_to_gguf.py to export GGUF adapter beside best weights",
    )
    parser.add_argument(
        "--embedder-data",
        default="",
        help="JSONL of {domain, vector} teacher routing samples for embedder calibration",
    )
    parser.add_argument(
        "--embedder-out",
        default="",
        help="output path for distilled router_adapter.json",
    )
    parser.add_argument(
        "--force", action="store_true", help="run even while a game has the card"
    )
    return Settings(**vars(parser.parse_args(argv)))


def distill_embedder_router(data_path: Path, out_path: Path) -> int:
    """Computes normalized per-domain teacher centroids locally for fast tool-domain routing."""
    if not data_path.exists():
        say(f"Embedder dataset {data_path} not found.")
        return 1
    sums: dict[str, list[float]] = {}
    counts: dict[str, int] = {}
    dim = 0
    for raw_line in data_path.read_text(encoding="utf-8").splitlines():
        if not raw_line.strip():
            continue
        row = json.loads(raw_line)
        domain = str(row.get("domain", "")).strip()
        vec = row.get("vector")
        if not domain or not isinstance(vec, list) or not vec:
            continue
        floats = [float(x) for x in vec]
        if dim == 0:
            dim = len(floats)
        if len(floats) != dim:
            continue
        acc = sums.setdefault(domain, [0.0] * dim)
        for idx, val in enumerate(floats):
            acc[idx] += val
        counts[domain] = counts.get(domain, 0) + 1

    if dim == 0 or not sums:
        say("No valid embedder training samples found.")
        return 1

    centroids: dict[str, list[float]] = {}
    for domain, acc in sums.items():
        n = max(1, counts[domain])
        mean = [v / n for v in acc]
        norm = math.sqrt(sum(v * v for v in mean)) or 1.0
        centroids[domain] = [round(v / norm, 6) for v in mean]

    payload = {
        "version": 1,
        "dimension": dim,
        "scale": [1.0] * dim,
        "domainCentroids": centroids,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(out_path)
    say(f"Wrote distilled embedder adapter ({len(centroids)} domains) to {out_path}.")
    return 0


def convert_adapter_to_gguf(
    converter_script: Path, base_dir: Path, best_dir: Path, out_gguf: Path
) -> bool:
    """Invokes local llama.cpp LoRA-to-GGUF converter with fixed arguments and verifies output."""
    if not converter_script.exists() or not best_dir.exists():
        return False
    proc = subprocess.run(
        [
            sys.executable,
            str(converter_script),
            "--base",
            str(base_dir),
            "--outfile",
            str(out_gguf),
            str(best_dir),
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0 or not out_gguf.exists():
        say(f"GGUF adapter conversion skipped/failed: {proc.stderr.strip()[:240]}")
        return False
    digest = hashlib.sha256(out_gguf.read_bytes()).hexdigest()
    manifest = out_gguf.with_suffix(".manifest.json")
    manifest.write_text(
        json.dumps(
            {
                "version": 1,
                "gguf": str(out_gguf),
                "sha256": digest,
                "source": str(best_dir),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    say(f"Converted LoRA adapter to GGUF: {out_gguf} (sha256 {digest[:12]}...)")
    return True


def say(message: str) -> None:
    sys.stdout.write(message + "\n")
    sys.stdout.flush()


def train(settings: Settings) -> int:
    """Runs the tuning. Returns 0 when finished, 3 when it stopped for a game."""
    if settings.mode == "embedder":
        return distill_embedder_router(
            Path(settings.embedder_data or settings.data),
            Path(settings.embedder_out or Path(settings.out) / "router_adapter.json"),
        )
    if settings.device == "cuda" and not settings.force:
        game = game_on_card()
        if game is not None:
            say(
                f"A game is running ({game}). Not starting; run this again when it is closed."
            )
            return 3

    import torch
    from peft import LoraConfig, PeftModel, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    out = Path(settings.out)
    out.mkdir(parents=True, exist_ok=True)
    state_file = out / "state.json"
    adapter_dir = out / "adapter"
    best_dir = out / "best"

    examples = read_examples(Path(settings.data))
    if settings.limit > 0:
        examples = examples[: settings.limit]
    learn_from, held_out = split(examples, settings.held_out, settings.seed)
    say(
        f"{len(learn_from)} examples to learn from, {len(held_out)} held out to check against."
    )

    tokenizer = AutoTokenizer.from_pretrained(settings.base)

    def encode(example: Example) -> tuple[Any, Any] | None:
        coded = tokenizer(
            example.text, add_special_tokens=False, return_offsets_mapping=True
        )
        ids: list[int] = coded["input_ids"]
        if len(ids) > settings.max_tokens:
            return None
        labels = labels_for(coded["offset_mapping"], ids, example.spans)
        if all(label == IGNORE for label in labels):
            return None
        device = settings.device
        return (
            torch.tensor([ids], device=device),
            torch.tensor([labels], device=device),
        )

    on_card = settings.device == "cuda"
    load_kwargs: dict[str, Any] = {
        "dtype": torch.bfloat16 if on_card else torch.float32,
        "device_map": {"": settings.device},
    }
    if settings.qlora and on_card:
        try:
            from transformers import BitsAndBytesConfig

            load_kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16,
                bnb_4bit_use_double_quant=True,
            )
        except Exception:
            say("bitsandbytes not available; falling back to bfloat16 LoRA.")
    model = AutoModelForCausalLM.from_pretrained(settings.base, **load_kwargs)
    model.gradient_checkpointing_enable()
    model.config.use_cache = False

    run = fingerprint(settings)
    resumed: dict[str, Any] = {}
    if state_file.exists() and adapter_dir.exists():
        resumed = json.loads(state_file.read_text(encoding="utf-8"))
        if resumed.get("run") != run:
            other = f"{out} holds a run with other examples or settings."
            say(
                f"{other} Carrying it on would mix the two: give another --out, or empty it."
            )
            return 2
        model = PeftModel.from_pretrained(model, str(adapter_dir), is_trainable=True)
        say(f"Carrying on from step {resumed.get('step', 0)}.")
    else:
        model = get_peft_model(
            model,
            LoraConfig(
                r=settings.rank,
                lora_alpha=settings.alpha,
                lora_dropout=settings.dropout,
                target_modules=list(TARGETS),
                task_type="CAUSAL_LM",
            ),
        )
    trainable = [
        parameter for parameter in model.parameters() if parameter.requires_grad
    ]
    say(f"Adjusting {sum(p.numel() for p in trainable) / 1e6:.1f} million numbers.")
    optimiser = torch.optim.AdamW(trainable, lr=settings.lr, weight_decay=0.0)
    optimiser_file = adapter_dir / "optimiser.pt"
    if resumed and optimiser_file.exists():
        optimiser.load_state_dict(
            torch.load(optimiser_file, map_location=settings.device, weights_only=True)
        )

    def loss_of(example: Example) -> Any | None:
        coded = encode(example)
        if coded is None:
            return None
        ids, labels = coded
        shift_labels = labels[:, 1:]
        keep_idx = (shift_labels[0] != -100).nonzero(as_tuple=True)[0]
        if keep_idx.numel() == 0:
            return None
        with torch.autocast(settings.device, dtype=torch.bfloat16, enabled=on_card):
            try:
                out = model(input_ids=ids, logits_to_keep=keep_idx)
                logits = out.logits[0]
                target = shift_labels[0, keep_idx]
                return torch.nn.functional.cross_entropy(logits.float(), target)
            except TypeError:
                return model(input_ids=ids, labels=labels).loss

    def check() -> float:
        """Mean loss over the held-out examples: how well she does on ones she never saw."""
        if not held_out:
            return float("nan")
        model.eval()
        losses: list[float] = []
        with torch.no_grad():
            for example in held_out:
                loss = loss_of(example)
                if loss is not None:
                    losses.append(float(loss))
        model.train()
        # No example short enough to check against is "unknown", not "perfect".
        return sum(losses) / len(losses) if losses else float("nan")

    def save(step: int, best: float, history: list[dict[str, float]]) -> None:
        """Saves where the run stands. The adapter is swapped in whole and the note of
        which step it belongs to is written last, so a run killed part-way through
        saving carries on from the save before, never from half of one."""
        fresh = out / "adapter.new"
        model.save_pretrained(str(fresh))
        torch.save(optimiser.state_dict(), fresh / "optimiser.pt")
        old = out / "adapter.old"
        if adapter_dir.exists():
            adapter_dir.rename(old)
        fresh.rename(adapter_dir)
        shutil.rmtree(old, ignore_errors=True)
        state = {
            "run": run,
            "step": step,
            "best": best,
            "history": history,
            "settings": asdict(settings),
        }
        pending = state_file.with_suffix(".json.new")
        pending.write_text(json.dumps(state, indent=2), encoding="utf-8")
        pending.replace(state_file)

    updates_per_epoch = max(1, math.ceil(len(learn_from) / settings.accumulate))
    total = max(1, round(updates_per_epoch * settings.epochs))
    if settings.steps > 0:
        total = min(total, settings.steps)
    step = int(resumed.get("step", 0))
    best = float(resumed.get("best", math.inf))
    history: list[dict[str, float]] = list(resumed.get("history", []))
    check_every = max(1, updates_per_epoch // 4)
    model.train()
    started = time.monotonic()
    skipped = 0

    if step == 0:
        before = check()
        history.append({"step": 0, "held_out": before})
        say(f"Before any tuning, the held-out loss is {before:.4f}.")

    while step < total:
        epoch = step // updates_per_epoch
        order = list(learn_from)
        random.Random(settings.seed + epoch).shuffle(order)
        at = (step % updates_per_epoch) * settings.accumulate
        batch = order[at : at + settings.accumulate]
        for group in optimiser.param_groups:
            group["lr"] = rate_at(step, total, settings.lr, settings.warmup)
        running = 0.0
        counted = 0
        for example in batch:
            loss = loss_of(example)
            if loss is None:
                skipped += 1
                continue
            loss.backward()
            running += float(loss.detach())
            counted += 1
        # The mean over the examples that were really used, not over the ones skipped as
        # too long, which would quietly make that step a smaller one.
        if counted > 1:
            for parameter in trainable:
                if parameter.grad is not None:
                    parameter.grad /= counted
        torch.nn.utils.clip_grad_norm_(trainable, 1.0)
        optimiser.step()
        optimiser.zero_grad(set_to_none=True)
        step += 1

        if step % 5 == 0 or step == total:
            pace = (time.monotonic() - started) / max(
                1, step - int(resumed.get("step", 0))
            )
            left = (total - step) * pace / 60
            mean = running / max(1, counted)
            say(f"step {step}/{total}  loss {mean:.4f}  about {left:.0f} min left")
        if step % check_every == 0 or step == total:
            held = check()
            history.append({"step": step, "held_out": held})
            say(
                f"  held-out loss {held:.4f}"
                + ("  (best so far)" if held < best else "")
            )
            if held < best or math.isnan(held):
                best = held
                model.save_pretrained(str(best_dir))
            save(step, best, history)
        if on_card and not settings.force and step % 5 == 0:
            game = game_on_card()
            if game is not None:
                save(step, best, history)
                say(f"A game has started ({game}). Saved at step {step} and stopped.")
                return 3

    save(step, best, history)
    if skipped:
        say(
            f"{skipped} examples were skipped as longer than {settings.max_tokens} tokens."
        )
    if settings.convert_gguf:
        convert_adapter_to_gguf(
            Path(settings.convert_gguf),
            Path(settings.base),
            best_dir,
            out / "small-lora.gguf",
        )
    if settings.embedder_data:
        distill_embedder_router(
            Path(settings.embedder_data),
            Path(settings.embedder_out or out / "router_adapter.json"),
        )
    say(f"Finished. The best adapter is in {best_dir} (held-out loss {best:.4f}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(train(parse(sys.argv[1:])))
