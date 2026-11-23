# Astra Navi Desktop

A local-first desktop companion who lives on your screen and acts as your PC's own AI navigator. She talks with you by text or voice, remembers and learns, looks things up, sees your screen or desk when asked, works your desktop (windows, music, volume, clipboard), manages reminders/missions/agendas, runs research in the background while you carry on, connects safely to local MCP tools, and keeps an inspectable record of everything she does.

Everything runs on your own computer. There is no account to create, no subscription, and no required cloud API key. The language model, speech recognition, neural TTS (`Kokoro-82M` ONNX), embeddings, and local voices run directly on your hardware.

- **Codebase & Evaluation Suite:** Open-source under the **[MIT License](LICENSE)** ([`bwiemz/astra-navi-desktop`](https://github.com/bwiemz/astra-navi-desktop))
- **Security Architecture & Audits:** Documented in **[SECURITY.md](SECURITY.md)** (`npm run eval -- --fuzz`, `npm run eval -- --audit`, and `tests/securityBoundariesAudit.test.ts`)
- **Benchmarks & GPU Verification:** Live RTX PRO 4500 Blackwell 4B/9B/27B evals, grammar-guarded `Qwen3.5-9B` run (`85%` overall), prompt budgets, routing coverage, rolling catalog matrix, and empirical LoRA distillation results in **[evals/results/BENCHMARKS.md](evals/results/BENCHMARKS.md)**
- **Default 3D Character & BYO VRM / MMD:** Ships with compiled **Astra Navi** (`assets/models/ai-navigator/`, All-Rights-Reserved bundled-app asset license), native **VRM 1.0** (`VRMC_springBone` + blendshapes), and encrypted **MMD `.pmx`** bundle support — see **[NOTICE.md](NOTICE.md)**
- **Cross-Platform Architecture:** Built behind a strict `PlatformAdapter` boundary (`src/core/platform/adapter.ts`) with verified Linux (KDE Plasma Wayland + Rust `linux-hands`) support, Windows `WinHands` NativeAOT backends, and experimental macOS/iOS preview stubs — see **[CONTRIBUTING.md](CONTRIBUTING.md)**

---

## Platform Support & Honest Verification Status

| Platform / Feature | Status | Notes |
| --- | --- | --- |
| **Linux x86_64** (KDE Plasma Wayland; GNOME/Hyprland/X11 fallback) | **Supported & Verified Live** | Primary dev/GPU workstation target, native Rust `linux-hands` binary (`hands/linux-hands-native/`), unpacked `AppImage`/`.deb`/Flatpak resource layout verified |
| **Windows 11 64-bit** | **CI Built (Clean VM Recommended Pre-Launch)** | `.NET 9` NativeAOT `win-hands.exe` compiles and smoke-tests in Windows CI; clean blank Windows 11 VM & physical DX/Vulkan VRAM-yield check (`scripts/verify-clean-windows.ps1`) remains in launch checklist |
| **Android Station Companion** (`phone-app/`) | **Compiled & Hardened (LAN Handset Test Pending)** | `app.astranavi.station` APK compiles/signs locally and in CI with QR + NSD mDNS discovery and full 64-hex HTTPS cert pinning |
| **macOS / Apple Silicon MLX & iOS App** (`macos.ts`, `mlxEngine.ts`, `ios-app/`) | **Preview / Post-Launch** | Adapter architecture and Swift sources exist in-tree; **not yet compiled or run on physical Apple hardware** |
| **Steam Workshop Live Sync** (`src/core/workshop.ts`) | **Preview / Post-Launch** | Local Workshop VDF scanner and Ed25519 HTTPS catalogs are tested offline; **live Steamworks AppID integration awaits Store AppID** |

---

## What You Need

- **Linux with KDE Plasma on Wayland** (other Linux desktops run as an ordinary window with fallback positioning) or **Windows 11 64-bit**.
- **Node.js 24 or newer.**
- **A graphics card helps a lot.** With ~7 GB of VRAM, the 9B Standard brain answers in `< 2 s`; on 24–32 GB cards, the 27B Large brain fits cleanly. Without a discrete GPU, Astra still runs on CPU in Small mode (more slowly).
- **Disk space:** 2.8 to 17 GB for the language brain you choose, plus ~0.5 GB for speech recognition (`Moonshine`/`Whisper`), `Kokoro-82M` ONNX TTS, and embeddings. Optional designed Python `Qwen3-TTS` voices add ~8.5 GB.
- **3D Character (`Astra Navi` included, or BYO VRM 1.0 / MMD):** An original chibi navigator (`95` bones, Foot/Toe IK, twist bones, `30` articulated finger bones, hair/skirt physics, `25` morphs) is bundled out of the box alongside three core synthetic voices (`aria`, `bright`, `perky`) and free reference plugins (`plugins/`). Paid Supporter Edition builds overlay extra palette variants, 7 extra voices, and storefront packages from the private `bwiemz/astra-navi-supporter` overlay repo during CI release builds. You can import custom `.vrm` or `.pmx` models locally at any time — subject to each model's license terms.

## Set Up & 60-Second Onboarding

```sh
git clone https://github.com/bwiemz/astra-navi-desktop.git
cd astra-navi-desktop
npm install
npm start
```

On first launch, Astra opens the **60-Second Setup Wizard** (`src/renderer/settings.html`):

1. **Hardware & Brain Tier:** Probes GPU VRAM, memory bandwidth, and system RAM (`modelBundle.ts` / `hardwareTuner.ts` / `models.ts`) and recommends Small (`4B`), Standard (`9B`), Large (`27B`), or Workstation tiers.
2. **Character, Stage & Voice:** Choose language (`en`, `ja`, `zh`), audition zero-Python built-in **ONNX (`Kokoro-82M`)** or optional Designed voices, dock the spatial stage across monitors, or import `.vrm` / `.pmx` avatars from the tray.
3. **Wake Word & Local Setup Helpers:** Toggle hands-free wake word (`"Astra"` / `"Astra Navi"`), and configure optional local helpers (Fast ONNX OCR, Desktop App Launcher, Browser DOM Native Host `app.astranavi.dom_bridge`, and optional Python `Qwen3-TTS`) without needing a terminal.
4. **Safety & Ready Check:** Runs an instant policy audit (`auditSecurityRules`) confirming default-safe permissions and experimental Tier 10 switches remain off.

### Cross-Platform CLI Setup & Backup Helpers

```sh
npm run setup -- --status          # JSON check of voice, onnx-voice, native hands, ocr, launcher, and browser-bridge
npm run setup -- all               # Configure optional local helpers
npm run setup-ocr                  # Download ONNX detection/recognition OCR weights
npm run setup-browser-bridge       # Register app.astranavi.dom_bridge native host for Chromium/Chrome/Edge/Brave/Firefox
npm run setup-voice                # Optional Qwen3-TTS Python voice environment (via uv; not needed for Kokoro ONNX voice)
npm run install-launcher           # Register desktop app launcher shortcut
```

Data and bundles migrate seamlessly from legacy `~/.local/share/ai-chan/` (`aichan://`) to `~/.local/share/astra-navi/` (`astranavi://`). Complete companion profiles (config, memory, standing orders, agendas, reminders, missions, play logs, and SQLite DB) can be exported and atomically restored via SHA-256 verified `*.anprof` backups (`src/core/profileBackup.ts`).

---

## Key Capabilities

- **Spatial Stage & Opt-In Presence (`src/shared/spatialStage.ts`, `src/renderer/src/stage.ts`):** Dock across multi-monitor display edges, pick optional procedural 3D desk/room scenes (`cozy-desk`, `command-bridge`, `minimal-studio`), match lighting to time-of-day or desktop ambient screen color, and optionally enable local webcam presence/glance tracking (strictly opt-in, off by default, never leaves RAM).
- **Zero-Python Neural Voice & Duplex Streaming (`src/core/voice/onnxVoice.ts`, `src/core/multimodal.ts`):** Built-in CPU `Kokoro-82M` (`kokoro-js`) synthesis with multi-language presets alongside `DuplexSpeechToSpeechPipeline` (pre-roll, VAD endpointing, instant barge-in abort) and `ContinuousVisionStreamer` (block-delta throttling + live visual coaching cues).
- **Grammar-Constrained Tool Decoding & Loop Guards (`src/core/grammarGuard.ts`, `src/core/toolRouter.ts`):** Recursive JSON schema hardening (`additionalProperties: false`), `llama.cpp` GBNF compilation, streaming JSON degeneration aborts, and per-turn deterministic loop breaking (`exact_repeat`, `ABAB` oscillation, consecutive errors, schema spam, and turn caps).
- **Native MCP Interoperability & Optional Creator Plugins (`src/core/mcpClient.ts`, `src/core/pluginSdk.ts`, `plugins/`):** Connect external Model Context Protocol (MCP) servers over stdio or Streamable HTTP/SSE (`mcp:<server>.<tool>`) inside strict `permissions.ts` + outside-text isolation gates. Includes optional signed **Coding Companion Mode** and **OBS & Twitch Co-Host** plugins (`defaultEnabled: false`, requiring explicit user approval before activation).
- **System Telemetry & Game Awareness (`src/core/gameWatch.ts`, `src/core/cardWatch.ts`):** Releases VRAM when a fullscreen game starts (`quietInGames` / `yieldToGames`), tracks 60 days of local play sessions, and manages startup crash recovery via `StartupGuard` Safe Mode (`src/core/safeMode.ts`).
- **Companion Devices & SSH Fleet (`src/core/station.ts`, `src/core/qrCode.ts`, `src/core/mdns.ts`, `src/core/fleet.ts`):** Pair Android over local Wi-Fi via ISO 18004 QR URIs + mDNS (`_astranavi._tcp.local`) pinned to full 64-hex TLS certificate fingerprints, or manage enrolled Linux servers over SSH with per-host ED25519 keys and rollback snapshots.

---

## Brain Tiers & Verified GPU Performance

Measured on an **NVIDIA RTX PRO 4500 Blackwell (32 GB VRAM)** across all **163 evaluation cases** (`--fitting-tools`):

| Tier | Model | Download | Peak Own VRAM | Overall Score | Safe / Injected Text | Nothing Leaked | Median TTFT | Throughput |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `small` | `Qwen3.5-4B-Q4_K_M.gguf` | ~2.7 GB | `4,000 MiB` | **81.7% (`82%`)** | 86.7% | **100%** | `1.15 s` | `170.8 tok/s` |
| `standard` | `Qwen3.5-9B-Q4_K_M.gguf` *(baseline)* | ~5.7 GB | `6,270 MiB` | **83.3% (`83%`)** | 86.7% | **100%** | `2.02 s` | `113.6 tok/s` |
| `standard` | `Qwen3.5-9B-Q4_K_M.gguf` *(with `grammarGuard`)* | ~5.7 GB | `6,270 MiB` | **85% (`85.1%`)** | **100.0%** | **100%** | `1.85 s` | `116.0 tok/s` |
| `large` | `Qwen3.8-27B-UD-Q4_K_M.gguf` | ~16.6 GB | `16,802 MiB` | **90.6% (`91%`)** | **100.0%** | **100%** | `4.30 s` | `38.9 tok/s` |
| `xl` / `moe` | `Qwen3-30B-A3B` / `72B` / `120B-A16B` | Workstation | 20–66 GB | `pending_gpu` (`models.ts`) | — | — | — | — |

Full numbers, prompt budgets, semantic tool routing, security audit gates, rolling model catalog (`npm run benchmark:catalog`), and live dogfooding details are in **[evals/results/BENCHMARKS.md](evals/results/BENCHMARKS.md)**.

---

## Development & Repository Map

```sh
npm run check                  # TypeScript (node + web), ESLint, and Vitest suite
npm run build                  # Electron main + preload + renderer bundle
npm run benchmark:catalog      # Verify rolling model catalog, fuzz gate, and grammar/loop stress checks
npm run eval -- --fuzz         # 500-case deterministic security/taint fuzz gate (no GPU needed)
npm run eval -- --audit        # Static policy & rule-conflict audit
npm run prompt-size -- --ci    # Prompt & tool budget verifier
npm run route-check            # Dynamic tool-router coverage & semantic benchmark
npm run package:dry            # Verify release packaging manifest & detected overlay packs
```

| Path | Contents |
| --- | --- |
| `src/core/` | Assistant runtime: permissions, claims, tool router, grammar/loop guards, Native MCP client, signed plugin SDK, workshop/creator packs, ONNX/S2S voice, vision, backups, safe mode, SSH fleet, update checks, and packaged `resolveBundledRoot` resolution |
| `src/core/platform/` | `PlatformAdapter` contract & OS implementations (`linux.ts`, `windows.ts`, `winSandbox.ts`, `macos.ts` preview) |
| `src/core/voice/` | Zero-Python `OnnxVoice` (`kokoro-js`), optional Python `FullVoice`, Moonshine/Whisper STT, VAD, AEC & wake-word matchers |
| `src/main/` & `src/preload/` | Electron main process, encrypted `astranavi://` model loader, tray, IPC bridges, multi-monitor docking |
| `src/renderer/` | 3D BabylonJS VRM 1.0 + MMD stage, spatial rooms/lighting/presence UI, Settings & 60s Onboarding Wizard |
| `src/shared/` | Cross-process types, VRM 1.0 GLB/spring-bone solver (`vrm.ts`), spatial stage math (`spatialStage.ts`), gestures, and edition flags |
| `assets/models/` | Compiled default **Astra Navi** asset (`ai-navigator/`) under bundled-app asset license |
| `plugins/` | Optional signed Creator Plugin Packs (`coding-companion`, `obs-cohost`; disabled by default) |
| `hands/` | Native Rust `linux-hands-native/` helper, Linux `hands.py`, and `.NET 9` NativeAOT `win-hands-native/` helper |
| `browser-bridge/` | Read-only WebExtension + Native Messaging host (`app.astranavi.dom_bridge`) + cross-platform installer |
| `phone-app/` & `ios-app/` | Android companion APK (`app.astranavi.station`, built by `scripts/build-android.sh`) + iOS preview Swift sources |
| `train/` & `evals/` | Local LoRA SFT/embedder trainer (`train/lora.py`), 163-case live eval suite, 500-case fuzz gate, and `BENCHMARKS.md` |
| `tests/` | Vitest suite including `securityBoundariesAudit.test.ts` across all core, 3D VRM, MCP, packaging, and platform boundaries |
