"""Speech server for AI-chan's full voice.

Runs Qwen3-TTS on this computer and speaks sentences in one consistent voice: the
designed reference clip in ``assets/voice``. The desktop app starts this program and
talks to it over pipes; nothing here opens a network port.

Protocol
    stdin   one JSON object per line: {"id": 1, "text": "...", "language": "English"}
    fd 3    for each request, one JSON line {"id", "ok", "sampleRate", "samples"} followed
            by ``samples`` little-endian float32 values; or {"id", "ok": false, "error"}.
            A first line {"ready": true, ...} is written once the model has loaded.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, BinaryIO

import numpy as np
import torch
from qwen_tts import Qwen3TTSModel

PROTOCOL_FD = 3
MAX_TEXT_CHARS = 600


def load_model(name: str) -> tuple[Any, str]:
    """Loads the model on the graphics card when there is one, otherwise on the processor."""
    if torch.cuda.is_available():
        return Qwen3TTSModel.from_pretrained(
            name, device_map="cuda:0", dtype=torch.bfloat16
        ), "cuda"
    return Qwen3TTSModel.from_pretrained(
        name, device_map="cpu", dtype=torch.float32
    ), "cpu"


def send(
    out: BinaryIO, header: dict[str, Any], audio: np.ndarray | None = None
) -> None:
    out.write((json.dumps(header) + "\n").encode("utf-8"))
    if audio is not None:
        out.write(audio.astype("<f4", copy=False).tobytes())
    out.flush()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Speech server for AI-chan's full voice."
    )
    parser.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-0.6B-Base")
    parser.add_argument(
        "--reference",
        type=Path,
        required=True,
        help="The designed voice's reference clip (wav).",
    )
    parser.add_argument(
        "--reference-text",
        type=Path,
        required=True,
        help="Text file with the words spoken in it.",
    )
    args = parser.parse_args()

    out = os.fdopen(PROTOCOL_FD, "wb", buffering=0)
    try:
        model, device = load_model(args.model)
        voice = model.create_voice_clone_prompt(
            ref_audio=str(args.reference),
            ref_text=args.reference_text.read_text(encoding="utf-8").strip(),
        )
    except Exception as error:  # noqa: BLE001 - whatever went wrong, the app must be told
        send(out, {"ready": False, "error": f"{type(error).__name__}: {error}"})
        return 1
    send(out, {"ready": True, "model": args.model, "device": device})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id: Any = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            text = str(request["text"]).strip()[:MAX_TEXT_CHARS]
            if not text:
                raise ValueError("nothing to say")
            with torch.inference_mode():
                wavs, sample_rate = model.generate_voice_clone(
                    text=text,
                    language=str(request.get("language", "Auto")),
                    voice_clone_prompt=voice,
                )
            audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
            send(
                out,
                {
                    "id": request_id,
                    "ok": True,
                    "sampleRate": int(sample_rate),
                    "samples": int(audio.size),
                },
                audio,
            )
        except Exception as error:  # noqa: BLE001 - one bad sentence must not end the server
            send(
                out,
                {
                    "id": request_id,
                    "ok": False,
                    "error": f"{type(error).__name__}: {error}",
                },
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
