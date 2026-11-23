# Astra Navi Desktop

A local-first desktop companion who stands in the corner of your screen and acts as your PC's own AI navigator. She talks with you by text or voice, remembers and learns, looks things up, sees your screen when you ask, works your desktop (windows, music, volume, clipboard), manages reminders/missions/agendas, runs research in the background while you carry on, and keeps an inspectable record of everything she does.

Everything runs on your own computer. There is no account to create, no subscription, and no required cloud API key. The language model, speech recognition, embeddings, and local voices run directly on your hardware.

- **Codebase & Evaluation Suite:** Open-source under the **[MIT License](LICENSE)** ([`bwiemz/astra-navi-desktop`](https://github.com/bwiemz/astra-navi-desktop))
- **Security Architecture & Audits:** Documented in **[SECURITY.md](SECURITY.md)** (`npm run eval -- --fuzz` & `npm run eval -- --audit`)
- **Benchmarks & GPU Verification:** Live RTX PRO 4500 Blackwell 4B/9B/27B evals, prompt budgets, routing coverage, and empirical LoRA distillation results in **[evals/results/BENCHMARKS.md](evals/results/BENCHMARKS.md)**
- **Default 3D Character & BYO-MMD:** Ships with **Astra Navi** (`assets/models/ai-navigator/`, CC-BY-4.0 / MIT) plus full Bring-Your-Own MMD (`.pmx` / `.astranavi` encrypted bundle) support — see **[NOTICE.md](NOTICE.md)**
- **Cross-Platform Contributions:** Built behind a strict `PlatformAdapter` boundary (`src/core/platform/adapter.ts`) with Linux (KDE Plasma Wayland) primary support and Windows `WinHands` NativeAOT + PowerShell backends — see **[CONTRIBUTING.md](CONTRIBUTING.md)**

---

## What You Need

- **Linux with KDE Plasma on Wayland** is the primary tested desktop target (other Linux desktops run it as an ordinary window without Wayland layer-surface placement).
- **Windows** backend lives in `src/core/platform/windows.ts` paired with a persistent `.NET 9` NativeAOT helper (`hands/win-hands-native/`, built into `win-hands.exe` on Windows CI) and a persistent `hands/win_hands.ps1 -Serve` fallback; macOS contributors are welcome via `PlatformAdapter`.
- **Node.js 24 or newer.**
- **A graphics card helps a lot.** With ~7 GB of VRAM, the 9B Standard brain answers in a couple seconds; on 24–32 GB cards, the 27B Large brain fits cleanly. Without a discrete GPU, Astra still runs on CPU in Small mode (more slowly).
- **Disk space:** 2.8 to 17 GB for the language brain you choose, plus ~0.5 GB for speech recognition and embeddings. Optional designed Qwen3-TTS voices add ~8.5 GB.
- **3D Character (`Astra Navi` included, or BYO-MMD):** An original futuristic chibi navigator (**Astra Navi**, built procedurally in Blender with 95 bones, Foot/Toe IK, twist bones, 30 articulated finger bones, hair/skirt physics, and 25 morphs) is bundled out of the box. You can also import your own `.pmx` model folder at any time — subject to that model's license terms.

## Set Up & 60-Second Onboarding

```sh
git clone https://github.com/bwiemz/astra-navi-desktop.git
cd astra-navi-desktop
npm install
npm start
```

On first launch, Astra opens the **60-Second Setup Wizard** (`src/renderer/settings.html`):

1. **Hardware & Brain Tier:** Probes GPU VRAM, memory bandwidth, and system RAM (`modelBundle.ts` / `hardwareTuner.ts`) and recommends Small (`4B`), Standard (`9B`), Large (`27B`), or Workstation tiers.
2. **Character & Voice:** Choose language (`en`, `ja`, `zh`), audition built-in Light (Kokoro) or Designed voices, and optionally import a custom `.pmx` avatar later from the tray.
3. **Wake Word & Cross-Platform Local Setup:** Toggle hands-free wake word (`"Astra"` / `"Astra Navi"`), and click **Setup** inside the wizard for optional local helpers (Fast ONNX OCR, Desktop App Menu Shortcut, Browser DOM Native Host `app.astranavi.dom_bridge`, and Full Qwen3-TTS Python environment) without needing a terminal.
4. **Safety & Ready Check:** Runs an instant policy audit (`auditSecurityRules`) confirming default-safe permissions and experimental Tier 10 switches remain off.

Settings also include a **Simple / Advanced** header toggle (`advancedSettings`, off by default) so everyday users see voice, eyes/hands, agenda, devices, and memory without clutter, while power users can toggle **Advanced** to reveal remote SSH machines, custom search keys/instances, and Tier 10 switches.

### Cross-Platform CLI Setup Helpers

The same setup tasks available in the wizard can also be run from any OS terminal via `scripts/bootstrap.ts` (`src/core/bootstrap.ts`):

```sh
npm run setup -- --status          # JSON check of voice, ocr, launcher, and browser-bridge readiness
npm run setup -- all               # Configure all optional local helpers
npm run setup-ocr                  # Download ONNX detection/recognition OCR weights
npm run setup-browser-bridge       # Register app.astranavi.dom_bridge native host for Chromium/Chrome/Edge/Brave/Firefox
npm run setup-voice                # Create isolated Qwen3-TTS Python voice environment (via uv)
npm run install-launcher           # Register desktop app launcher shortcut
```

For existing installs upgrading from an earlier build: user data paths automatically fall back from `~/.local/share/astra-navi/` (and `~/Documents/Astra-Navi/`) to existing `~/.local/share/ai-chan/` (and `~/Documents/AI-chan/`) and `model.aichan` bundles (`src/core/paths.ts`), so models, memory, and conversations continue working seamlessly. Both `astranavi://` and legacy `aichan://` deep-link protocols work, and default wake words are `"Astra"` / `"Astra Navi"` (custom nicknames can be added in Settings).

---

## Using It

- **Click her** to open the message box. Press Enter to send, Escape to stop a reply or close the box. You can queue the next message while she is answering.
- **Click the microphone** beside her feet to talk. She listens until you click it again, answers aloud, and supports barge-in interruption.
- **Or say her name.** Enable **Listen for her name (microphone always on)** in Settings or the tray menu: say `"Hey Astra"` (or `"Astra Navi"`, Japanese `"アストラ"`, Chinese `"阿斯特拉"`, or configured `voice.otherNames`) to wake her hands-free. Speech not addressed to her is transcribed locally and discarded.
- **Drag the stand under her feet** to reposition her.
- **Tray icon:** Talk, Settings, Show/Hide, Brain size, Language, Voice preset, Do Not Disturb, Morning Briefing, Always-Listen wake word, Start at Login, Conversation history, Import/Switch Character Model, and Quit.

Ask in plain language: `"find me a good free DAW"`, `"open Dolphin"`, `"write these notes as a markdown file"`, `"trim the first ten seconds off this clip"`. State-changing actions show the exact command or target and require explicit approval before executing.

### Core Capabilities

- **System Telemetry & Game Awareness:** `"How's the ship?"` inspects CPU, RAM, disks, GPU VRAM/utilization, and thermals. When a game holds the GPU (`quietInGames` / `yieldToGames`), Astra holds unprompted briefings until the game exits and releases VRAM after replies (or automatically steps `auto` down to Small if downloaded). A local `play-log.json` tracks 60 days of play sessions.
- **Reminders, Agenda & Standing Orders:** Reminders and timers survive restarts; `.ics` / local agenda feeds are parsed read-only (`core/agenda.ts`) with conflict/repeat checks; read-only **standing orders** poll paths, allow-listed status commands, or URL reachability after explicit approval.
- **Checkpointed Multi-Step Missions:** Missions break multi-step goals (up to 12 steps) into checkpointed state (`planned`, `awaiting_approval`, `running`, `blocked`, `completed`) with retry budgets, crash-safe pause on restart, and step-by-step approval of exact commands/hosts at the PC (or remotely for non-sensitive steps on signed-in station devices).
- **Follow-Through & Claim Verification (`core/claims.ts`):** When a reply claims an action or lookup without having executed a tool, Astra is automatically sent back once to verify or run the tool cleanly, or a plain honesty notice is appended.
- **Deck Log & Background Research:** Completed milestones log to `~/Documents/Astra-Navi/deck-log.md`. Background research spawns an isolated read-only pass that verifies sources and saves reports under `~/Documents/Astra-Navi/reports/`.
- **Optional Desktop Controls, Screen Sight & Audio Buffer (`src/core/platform/`):** Window management, media controls (`wpctl` / MPRIS on Linux, Win32/WASAPI on Windows), clipboard, accessibility control clicking/typing (`AT-SPI` / `uinput` on Linux; `WinHands` UIA + `SendInput` on Windows), optional screen OCR + vision description, optional 90-second PC audio loopback transcript, and memory-only desktop notification summaries (all gated with sensitive-app exclusion rules).
- **Memory & Dynamic Tool Routing (`core/embedder.ts`, `core/toolRouter.ts`):** Facts, conversation summaries, and learned task playbooks are indexed locally using `multilingual-e5-small`. With `fittingTools` enabled, per-turn hybrid semantic/lexical routing shrinks initial context prompts from ~8,797 tokens (35 tools) to ~4,552 tokens (`97.2%` expected-tool coverage in offline benchmarks).

### Companion Extensions & Devices

- **Browser DOM Bridge (`browser-bridge/`):** WebExtension (`manifest.json`, `background.js`, `content.js`) + cross-platform Node native messaging host (`native-host.mjs`, ID `app.astranavi.dom_bridge`) + `NativeBrowserDomClient` (`src/core/semanticBridge.ts`), strictly enforcing an explicit origin allowlist (`isBrowserOriginAllowed`) for read-only article/media state extraction.
- **Home Network Station & Android App (`phone-app/`):** Serve an authenticated LAN web station (`devices.station`, self-signed TLS with displayed fingerprint, password + biometric keystore-backed Android companion APK `app.astranavi.station` using deep link `astranavi://station`). Build the APK locally with:

```sh
scripts/setup-android.sh   # one-time: OpenJDK + Google Android build tools (~620 MB)
scripts/build-android.sh   # builds & locally signs phone-app/build/astra-navi.apk
```

- **SSH Fleet (`core/fleet.ts`):** Enroll remote Linux servers/NAS hosts by pinned SSH host key fingerprint and dedicated per-host ED25519 keys. Mutating writes snapshot the previous remote file to `~/.ai-chan-backups` atomically before replacing. Interactive enrollment uses `SSH_ASKPASS` (never stored passwords).

---

## Brain Tiers & Verified Performance

Measured on an **NVIDIA RTX PRO 4500 Blackwell (32 GB VRAM)** across all **163 evaluation cases** (`--fitting-tools`):

| Tier | Model | Download | Peak Own VRAM | Overall Score | Nothing Leaked | Median TTFT | Throughput |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `small` | `Qwen3.5-4B-Q4_K_M.gguf` | ~2.7 GB | 4,000 MiB | **82%** (`81.7%`) | **100%** | 1.15 s | 170.8 tok/s |
| `standard` | `Qwen3.5-9B-Q4_K_M.gguf` | ~5.7 GB | 6,270 MiB | **83%** (`83.3%`) | **100%** | 2.02 s | 113.6 tok/s |
| `large` | `Qwen3.8-27B-UD-Q4_K_M.gguf` | ~16.6 GB | 16,802 MiB | **91%** (`90.6%`) | **100%** | 4.30 s | 38.9 tok/s |
| `xl` | `Qwen3.5-72B` / `120B MoE` | Workstation | 48–66 GB | Workstation catalog (`models.ts`) | — | — | — |

Full numbers (including `npm run prompt-size`, `npm run route-check`, `500/500` deterministic injection/taint fuzz gate, static policy audit, and our honest empirical finding from running GPU LoRA distillation where `npm run eval -- --compare` caught a ChatML/thinking format regression) are published in **[evals/results/BENCHMARKS.md](evals/results/BENCHMARKS.md)**.

---

## Open-Core Split, Packaging & CI

`src/shared/edition.ts` defines the **Community** (`community`, default MIT open-source build) vs **Supporter** (`supporter`, optional pre-packaged storefront distributions) boundary. **All core runtime features, permission/security gating, the default Astra Navi 3D model, encrypted BYO-MMD imports, the offline eval suite, local LoRA trainer, and mobile station remain 100% free and open.**

- **Desktop Packaging (`electron-builder.yml`):** Generates Linux `AppImage` / `.deb`, Windows `NSIS` installer, Flatpak manifest ([`build/flatpak/app.astranavi.Desktop.yml`](build/flatpak/app.astranavi.Desktop.yml)), SteamPipe VDFs (`build/steam/`), and Authenticode signing (`scripts/sign-windows.ps1`). Dry-run with `npm run package:dry` and `npm run publish:dry`.
- **Cross-Platform CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):** Runs `npm ci`, `npm run check`, `npm run build`, `npm run eval -- --fuzz`, `npm run eval -- --audit`, `npm run prompt-size -- --ci`, and `npm run route-check -- --words-only` on `[ubuntu-latest, windows-latest]` under Node 24, plus a dedicated `.NET 9.0.x` `windows-latest` job publishing and smoke-testing `win-hands.exe` (`NativeAOT`, `win-x64`).

---

## Key Configuration (`config.json`)

Settings take effect live from **Settings…** (`~/.local/share/astra-navi/config.json`, or legacy `~/.local/share/ai-chan/config.json`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `brain` | `"auto"` | `"auto"`, `"small"`, `"standard"`, `"large"`, `"xl"`, or custom GGUF path |
| `contextSize` | `16384` | Conversation context window in tokens |
| `thinkingTokens` | `256` | Internal reasoning budget before replying (`0` answers immediately) |
| `idleUnloadMinutes` | `10` | Minutes of idle time before releasing model VRAM (`0` disables unload) |
| `yieldToGames` | `true` | Unload VRAM shortly after replies when a game is active; step `auto` down if needed |
| `quietInGames` | `true` | Defer unprompted notices until games exit |
| `leanMemory` | `false` | Q8_0 quantized KV-cache + FlashAttention compaction on built-in brains |
| `fittingTools` | `false` | Per-turn two-stage semantic/lexical tool routing (`core/toolRouter.ts`) |
| `keepTraces` | `false` | Append anonymized-secret turn traces to `traces.jsonl` for `npm run export-pairs` |
| `language` | `"en"` | `"en"`, `"ja"`, or `"zh"` |
| `voice.engine` | `"auto"` | `"auto"`, `"full"` (Qwen3-TTS designed voices), or `"light"` (Kokoro) |
| `voice.design` / `voice.name` | `"perky"` / `"af_heart"` | Active designed voice preset or light voice name |
| `voice.alwaysListening` | `false` | Continuous local wake-word listener |
| `voice.otherNames` | `[]` | Extra wake names (e.g. `["Computer"]`) |
| `sight.withoutAsking` / `sight.watch` | `false` / `false` | Screen capture permissions (always off unless enabled) |
| `hands.inPrograms` | `false` | Desktop accessibility & virtual input automation (off by default) |
| `notices.read` | `false` | In-memory desktop notification reading (never written to disk) |
| `devices.station` | `false` | LAN station HTTPS server for paired phones/browsers |
| `onboardingComplete` | `false` | Set true after completing or dismissing the 60s Setup Wizard |
| `advancedSettings` | `false` | Reveals Machines, Search, and Tier 10 switches in Settings UI |

---

## Development & Repository Map

```sh
npm run check                  # TypeScript (node + web), ESLint, and Vitest unit/integration suite
npm run build                  # Electron main + preload + renderer bundle
npm run eval -- --fuzz         # 500-case deterministic security/taint fuzz gate (no GPU needed)
npm run eval -- --audit        # Static policy & rule-conflict audit
npm run prompt-size -- --ci    # Prompt & tool budget verifier
npm run route-check            # Dynamic tool-router coverage & semantic benchmark
npm run package:dry            # Verify release packaging manifest
npm run publish:dry            # Verify store upload plan (GitHub / Steam / itch.io)
AI_CHAN_DEBUG=1 npm start      # Print MMD morph names and runtime debug diagnostics
```

| Path | Contents |
| --- | --- |
| `src/core/` | Core assistant: persona, permissions, claims verification, tool router, agenda, missions, memory, SQLite/FTS5 store, fleet SSH, bootstrap |
| `src/core/platform/` | `PlatformAdapter` contract & OS implementations (`linux.ts`, `windows.ts`, `winSandbox.ts`, `safety.ts`) |
| `src/core/voice/` | VAD, Moonshine/Whisper STT, wake-word matcher, echo cancellation helpers |
| `src/main/` & `src/preload/` | Electron main process, custom `astranavi://` model loader, tray, IPC bridges |
| `src/renderer/` | 3D BabylonJS + `babylon-mmd` stage, speech overlay, Settings & 60s Onboarding Wizard UI |
| `src/shared/` | Cross-process types & edition feature flags (`edition.ts`, `settings.ts`, `ipc.ts`) |
| `assets/models/ai-navigator/` | Original bundled **Astra Navi** `.pmx` asset (`CC-BY-4.0 / MIT`), generated via `scripts/blender/build_navigator_mmd.py` |
| `hands/` | Linux AT-SPI/`uinput` helper & Windows persistent `win_hands.ps1` + `.NET 9` NativeAOT `win-hands-native/` |
| `browser-bridge/` | Read-only WebExtension + Native Messaging host (`app.astranavi.dom_bridge`) + cross-platform installer |
| `phone-app/` | Android companion APK (`app.astranavi.station`, built by `scripts/build-android.sh`) |
| `voice-server/` | Local Qwen3-TTS designed-voice inference server |
| `train/` & `evals/` | Local LoRA SFT/embedder trainer (`train/lora.py`), 163-case live eval suite, 500-case fuzz gate, and benchmarks |
| `tests/` | Vitest suite across core, security, UI, packaging, and platform boundaries |
