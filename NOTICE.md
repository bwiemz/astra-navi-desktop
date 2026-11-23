# Notice & Attribution

## Codebase & Bundled Character License

- **Core Codebase & Evaluation Suite:** Licensed under the **MIT License** ([LICENSE](LICENSE)). Open-core, local-first, and independent.
- **Bundled Original 3D Character (`Astra Navi`) & Supporter Variants:** Located in [`assets/models/ai-navigator/`](assets/models/ai-navigator/LICENSE.txt) and [`assets/models/variants/`](assets/models/variants/) (`astral-midnight`, `sakura-nebula`, `solar-dawn`), licensed under **CC-BY-4.0 / MIT**. Astra Navi and her textures were procedurally created and rigged from scratch using Blender (`scripts/blender/build_navigator_mmd.py`, `scripts/build-character-variants.ts`) with 100% original geometry, textures, and shaders so the application works out of the box without third-party assets.

## Bring-Your-Own VRM & MMD Models

`.gitignore` blocks arbitrary third-party character model binaries (`.pmx`, `.pmd`, `.fbx`, `.vrm`, `.aichan`, `.astranavi`, `.bpmx`) from being committed to this repository while explicitly allowing the original `assets/models/ai-navigator/ai-navigator.pmx` and first-party variants.

Users may supply any `.vrm` (VRM 1.0 / 0.x) or `.pmx` MMD model they are permitted to use and import it locally (`Import character model…` in the tray or `npm run import-model`). Importing packs the user-supplied model and its textures into one authenticated, encrypted local bundle in that user's data folder (`~/.local/share/astra-navi/`, with automatic fallback for existing `~/.local/share/ai-chan/` installs):

- **Per-machine key derivation:** Derived from a random local secret combined with machine identity and OS account name so packed third-party bundles do not travel across machines.
- **Per-entry keys & integrity checks:** Entry metadata and file contents are encrypted and authenticated; tampered bundles are rejected.
- **In-memory decryption:** Files are decrypted in memory on demand over the app's private custom protocol without writing loose model files back to disk.
- **Honest scope:** Local bundle packing deters casual extraction and redistribution; it is not DRM, since software running on a user's own hardware always has access to the assets it renders.

## Synthetic Voices

Astra Navi's bundled and optional voices are **100% synthetic**. The reference voice clips in `assets/voice` were synthesized from written timbre descriptions using the Apache-2.0 **Qwen3-TTS VoiceDesign** model; the built-in zero-Python voice uses the Apache-2.0 **Kokoro-82M** ONNX model (`kokoro-js`). No voice is recorded, sampled, or cloned from any human voice actor.

## Open-Weight Local AI Models

The assistant runs entirely on the user's computer using open-weight models downloaded from Hugging Face on user opt-in (none of their makers is affiliated with this project):

| Part                | Model                                                      | License         |
| ------------------- | ---------------------------------------------------------- | --------------- |
| Language            | Qwen3.5 4B / 9B / 72B / 120B-A16B, Qwen3-30B-A3B, Qwen3.8 27B (GGUF by Unsloth / Qwen) | Apache-2.0 |
| Speech (built-in)   | `onnx-community/Kokoro-82M-v1.0-ONNX` (`kokoro-js`)        | Apache-2.0      |
| Speech (designed)   | Qwen3-TTS 0.6B Base, 1.7B VoiceDesign (optional Python)    | Apache-2.0      |
| Speech recognition  | Moonshine Base (English), Whisper Small (other languages)  | MIT, Apache-2.0 |
| Voice detection     | Silero VAD                                                 | MIT             |
| Finding notes       | multilingual-e5-small (ONNX build by Xenova)               | MIT             |
| Describing pictures | Florence-2 base (ONNX build by onnx-community)             | MIT             |
| Screen OCR (setup)  | PaddleOCR v4 ONNX detection & recognition weights          | Apache-2.0      |

## Commercial & Redistributed Software Licenses & Protocol Specifications

All direct production npm packages, native helpers, and optional runtimes redistributed or invoked by **Astra Navi Desktop** (including commercial Supporter Edition builds) use permissive open-source licenses or open technical standards compatible with commercial distribution (`npm notice`, `OFL-1.1` font attribution):

| Component / Standard | Role | License / Spec |
| --- | --- | --- |
| `electron` | Cross-platform desktop shell & Chromium/Node runtime | MIT |
| `@babylonjs/core` | WebGL 3D character renderer, VRM mesh builder & PBR shaders | Apache-2.0 |
| `babylon-mmd` | PMX/VMD MMD model loader, physics & skeletal runtime | MIT |
| VRM 1.0 / glTF 2.0 (`VRMC_vrm`, `VRMC_springBone`, `VRMC_materials_mtoon`) | Pure-TS parser (`src/shared/vrm.ts`) implementing VRM Consortium & Khronos specifications | MIT (original code; open specs) |
| Model Context Protocol (MCP) JSON-RPC 2.0 | Pure-TS stdio & Streamable HTTP/SSE client (`src/core/mcpClient.ts`) | MIT (original client; Linux Foundation / Agentic AI Foundation spec) |
| `@fontsource/m-plus-rounded-1c` | Bundled UI typography (`SIL Open Font License 1.1`) | OFL-1.1 |
| `node-llama-cpp` | Local GGUF LLM inference bindings & GBNF grammar engine (`llama.cpp`) | MIT |
| `@huggingface/transformers` | Local embeddings, STT, and vision pipelines | Apache-2.0 |
| `kokoro-js` | Built-in zero-Python ONNX neural TTS | Apache-2.0 |
| `onnxruntime-node` | Local ONNX model execution (TTS, OCR, embeddings, VAD) | MIT |
| `sharp` | Local image resizing/format conversion for vision | Apache-2.0 |
| `zod` | IPC, plugin/workshop manifest, backup, and tool-schema validation | MIT |
| `linux-hands` (`hands/linux-hands-native/`) | Zero-dependency compiled Rust Linux input/D-Bus helper (`std` only) | MIT |
| `.NET 9` NativeAOT (`WinHands`) | Self-contained Windows UI Automation & input helper | MIT |
| ISO/IEC 18004 QR & RFC 6762 mDNS (`src/core/qrCode.ts`, `src/core/mdns.ts`) | Pure-TS QR matrix generator and LAN DNS-SD responder | MIT |
| PyTorch (optional `voice-server`) | Local Python GPU runtime for Qwen3-TTS (user setup) | BSD-3-Clause |

## System Integrations & Companion Apps

Working inside other programs uses the desktop's own accessibility service (AT-SPI / `linux-hands` on Linux, and Win32 / UI Automation via `hands/win-hands-native/` on Windows). The phone link uses KDE Connect or Astra's local LAN Station. The Station page served to paired home devices contains no character art and never serves the 3D character model: the model stays in its local bundle on the PC, and its self-signed TLS certificate is generated locally with OpenSSL.

Reaching the user's other machines uses OpenSSH as installed on the computer. Per-host ED25519 keys are generated on the user's computer and never leave it.

The Android app (`app.astranavi.station`, built by `scripts/build-android.sh`) is compiled with OpenJDK (Eclipse Temurin) and Google's Android build tools (`scripts/setup-android.sh`, subject to the Android SDK License), contains no character art or LLM weights, and communicates only with the user's paired Station over HTTPS pinned to its full SHA-256 certificate fingerprint.

## Public Knowledge Lookups

Lookups go to public APIs (`Wikipedia` CC BY-SA, `DuckDuckGo` Instant Answer, `Stack Exchange` CC BY-SA, `Arch Linux Wiki`, `Hacker News / Algolia`, and `Open-Meteo` CC BY 4.0) or the user's own configured SearXNG/Brave Search key. Astra Navi identifies itself honestly and never attempts to bypass anti-bot or authentication walls.
