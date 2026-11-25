#!/usr/bin/env bash
# Sets up AI-chan's full voice: a private Python environment with the Qwen3-TTS speech
# model's software. Needs `uv` (https://docs.astral.sh/uv/) and about 6 GB of disk; the
# model itself (about 2.5 GB more) downloads the first time she speaks.
set -euo pipefail

data_dir="${AI_CHAN_DATA_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/ai-chan}"
env_dir="${data_dir}/voice-env"

if ! command -v uv >/dev/null 2>&1; then
  echo "This needs the 'uv' tool. Install it from https://docs.astral.sh/uv/ and run this again." >&2
  exit 1
fi
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "No NVIDIA graphics card was found. The full voice will work but be too slow for conversation;" >&2
  echo "the light voice (the default without this set-up) is the better choice on this computer." >&2
fi

echo "Creating the voice environment in ${env_dir} ..."
uv venv --clear "${env_dir}" --python 3.12
uv pip install --python "${env_dir}/bin/python" qwen-tts

"${env_dir}/bin/python" -c "import torch, qwen_tts; print('Ready. Graphics card in use:', torch.cuda.is_available())"
echo "Done. Start AI-chan and pick a voice under 'Her voice' in the tray menu."
