"""Designs Astra Navi's voice from a written description.

This is how the reference clips in ``assets/voice`` were made, and how to make new ones.
The voice comes from the description alone. No recording of any person is given to the
model, so the result is an original synthetic voice, not a copy of anyone's.

    python design.py --out ../assets/voice --name bright --describe "A young woman's voice, ..."
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

DESIGN_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
# An original line written for this project, long enough to carry the voice's character.
REFERENCE_LINE = (
    "Captain! There you are! Astra Navi has been waiting all morning, you know. "
    "So, what are we working on today? Whatever it is, leave it to me!"
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Designs Astra Navi's voice from a written description."
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Folder to write the clip and its notes into.",
    )
    parser.add_argument(
        "--name",
        required=True,
        help="Short name for this voice, used as the file name.",
    )
    parser.add_argument(
        "--describe",
        required=True,
        help="What the voice should sound like, in plain words.",
    )
    parser.add_argument(
        "--line", default=REFERENCE_LINE, help="The words spoken in the reference clip."
    )
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    on_gpu = torch.cuda.is_available()
    model = Qwen3TTSModel.from_pretrained(
        DESIGN_MODEL,
        device_map="cuda:0" if on_gpu else "cpu",
        dtype=torch.bfloat16 if on_gpu else torch.float32,
    )
    with torch.inference_mode():
        wavs, sample_rate = model.generate_voice_design(
            text=args.line, language="English", instruct=args.describe
        )

    args.out.mkdir(parents=True, exist_ok=True)
    sf.write(args.out / f"{args.name}.wav", wavs[0], sample_rate)
    (args.out / f"{args.name}.txt").write_text(args.line + "\n", encoding="utf-8")
    (args.out / f"{args.name}.json").write_text(
        json.dumps(
            {
                "name": args.name,
                "description": args.describe,
                "model": DESIGN_MODEL,
                "seed": args.seed,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {args.out / (args.name + '.wav')} ({len(wavs[0]) / sample_rate:.1f}s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
