# Notice & Attribution

## Codebase & Bundled Character License

- **Core Codebase & Evaluation Suite:** Licensed under the **MIT License** ([LICENSE](LICENSE)). Open-core, local-first, and independent.
- **Bundled Original 3D Character (`Astra Navi`):** Located in [`assets/models/ai-navigator/`](assets/models/ai-navigator/LICENSE.txt) and licensed under **CC-BY-4.0 / MIT**. Astra Navi was procedurally created and rigged from scratch using Blender (`scripts/blender/build_navigator_mmd.py`) with 100% original geometry, textures, and shaders so the application works out of the box without third-party assets.

## Bring-Your-Own MMD (BYO-MMD) Models

`.gitignore` blocks arbitrary third-party character model binaries (`.pmx`, `.pmd`, `.fbx`, `.vrm`, `.aichan`, `.astranavi`, `.bpmx`) from being committed to this repository while explicitly allowing the original `assets/models/ai-navigator/ai-navigator.pmx` asset.

Users may supply any MMD (`.pmx`) model they are permitted to use and import it locally (`Import character model…` in the tray or `npm run import-model`). Importing packs the user-supplied model and its textures into one authenticated, encrypted local bundle in that user's data folder (`~/.local/share/astra-navi/`, with automatic fallback for existing `~/.local/share/ai-chan/` installs):

- **Per-machine key derivation:** Derived from a random local secret combined with machine identity and OS account name so packed third-party bundles do not travel across machines.
- **Per-entry keys & integrity checks:** Entry metadata and file contents are encrypted and authenticated; tampered bundles are rejected.
- **In-memory decryption:** Files are decrypted in memory on demand over the app's private custom protocol without writing loose model files back to disk.
- **Honest scope:** Local bundle packing deters casual extraction and redistribution; it is not DRM, since software running on a user's own hardware always has access to the assets it renders.

## Her voice

Her voices are synthetic. The designed voices in `assets/voice` were invented by the Qwen3-TTS VoiceDesign model from written descriptions (kept beside each clip); the light voice is a built-in voice of the Kokoro model. None of them is a recording, sample or clone of the character's voice actresses. The fan-use terms above cover the character model, not her voice, and a performer's voice is their own.

## The assistant

The assistant runs entirely on the user's computer. It uses open-weight models, each under its own licence:

| Part                | Model                                                     | Licence         |
| ------------------- | --------------------------------------------------------- | --------------- |
| Language            | Qwen3.5 4B / 9B, Qwen3.8 27B (GGUF builds by Unsloth)     | Apache-2.0      |
| Speech (designed)   | Qwen3-TTS 0.6B Base, 1.7B VoiceDesign                     | Apache-2.0      |
| Speech (light)      | Kokoro-82M                                                | Apache-2.0      |
| Speech recognition  | Moonshine Base (English), Whisper Small (other languages) | MIT, Apache-2.0 |
| Voice detection     | Silero VAD                                                | MIT             |
| Finding notes       | multilingual-e5-small (ONNX build by Xenova)              | MIT             |
| Describing pictures | Florence-2 base (ONNX build by onnx-community)            | MIT             |

The models are downloaded from Hugging Face by each user and are not part of this repository. None of their makers is affiliated with this project.

## Her reach beyond the window

Working inside other programs uses the desktop's own accessibility service (AT-SPI on Linux via `python-gobject`, and Win32 / UI Automation via `hands/win-hands-native/` on Windows). The phone link uses KDE Connect as installed by the user. The page served to paired home devices carries the project notice above, contains no character art, and never serves the 3D character model: the model stays in its encrypted bundle on the PC. Its certificate is generated locally with OpenSSL.

Reaching the user's other machines uses OpenSSH as installed on the computer. Her keys for them are made on the user's computer and never leave it.

The Android app (`app.astranavi.station`, built by `scripts/build-android.sh`) is compiled locally on your computer with OpenJDK (Eclipse Temurin) and Google's Android build tools, which are fetched by `scripts/setup-android.sh` (using them means accepting Google's Android SDK license). It contains no character art and no part of the language model, is signed with a key made on your computer, and is handed only to devices you have paired.

## Where she looks things up

Lookups go to services that publish an interface for programs. Each has its own terms, and none is affiliated with this project: Wikipedia (text under CC BY-SA), DuckDuckGo's Instant Answer API, the Stack Exchange API (content under CC BY-SA), the Arch Linux wiki, the Hacker News search API by Algolia, and Open-Meteo for weather (data under CC BY 4.0). She identifies herself honestly to all of them and does not try to get past a site that refuses automated visitors. A search engine is used only when the user sets up their own.
