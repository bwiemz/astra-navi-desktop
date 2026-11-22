# Her designed voices

Each `.wav` here is a short reference clip that defines one voice. The speech model reads the clip once and then speaks everything in that voice, in any of its languages.

The clips were made by `voice-server/design.py`, which asks the Qwen3-TTS VoiceDesign model to invent a voice from a written description. The description used for each one is in the `.json` file beside it, and the words spoken are in the `.txt` file. No recording of any person was given to the model, so these are original synthetic voices. They are not samples, recordings or copies of the character's voice actresses.

To make another, write your own description:

```sh
~/.local/share/ai-chan/voice-env/bin/python voice-server/design.py \
  --out assets/voice --name mine \
  --describe "A bright, high, cheerful young woman's voice, quick and playful."
```

It then appears under **Her voice** in the tray menu. Do not put a recording of a real person here.
