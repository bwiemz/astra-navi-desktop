# Astra Navi Desktop — Verification & Live GPU Benchmark Report

This report records the measured prompt sizes, semantic tool-routing efficiency, deterministic security/fuzz gates, live GPU evaluation results, end-to-end LoRA distillation experiment, and local field checks collected on real hardware before publishing `astra-navi-desktop`.

> All benchmark runs below used `--fitting-tools`, temperature `0.7`, context size `16,384` tokens, thinking budget `256` tokens, and an isolated temporary data directory (`0` side effects on host files). Temporary eval JSON/JSONL outputs and LoRA artifacts live outside git (`.gitignore` excludes `evals/results/*.json` and `*.jsonl`).

## Hardware & Model Environment

| Component | Measured / Used |
| --- | --- |
| GPU | NVIDIA RTX PRO 4500 Blackwell (`32,623 MiB` VRAM, driver `620.73.04`) |
| Small brain (4B) | `Qwen3.5-4B-Q4_K_M.gguf` |
| Standard brain (9B) | `Qwen3.5-9B-Q4_K_M.gguf` |
| Large brain (27B) | `Qwen3.8-27B-UD-Q4_K_M.gguf` |
| Embeddings / tool router | `multilingual-e5-small` |
| Runtime | Node.js `v24+`, `node-llama-cpp`, PyTorch + PEFT (`train/lora.py`) |

---

## 1. Prompt Budgets & Dynamic Two-Stage Tool Routing

### Prompt Size (`npm run prompt-size` & `--ci`)

| Configuration | Qwen3.5-4B GGUF Vocab | Offline CI Byte-BPE (`--ci`) |
| --- | --- | --- |
| Instructions alone (no optional abilities) | `2,921` tokens | `3,224` tokens |
| Instructions alone (all abilities enabled) | `3,247` tokens | `3,599` tokens |
| **Dynamic core baseline (11 routed core tools)** | **`4,552` tokens** | **`4,939` tokens** |
| Usual tools enabled (31 tools) | `7,321` tokens | `7,777` tokens |
| Everything enabled (35 tools) | `8,797` tokens | `9,338` tokens |

Dynamic two-stage routing (`CORE_TOOLS` + per-turn intent routing) cuts the initial prompt from `8,797` tokens (all tools) down to `4,552` tokens at baseline (`-48.3%`), keeping the Small (4B) and Standard (9B) KV cache roomy and first-reply latency low.

### Tool Routing Coverage (`npm run route-check`)

| Mode | Expected-Tool Case Coverage | Avg Tool Tokens / Msg | Median / Max Tokens | All 36 Tools Baseline | Roundabout Requests Covered |
| --- | --- | --- | --- | --- | --- |
| Full hybrid router (words + `multilingual-e5-small` + recent) | **69 / 71 (`97.2%`)** | **`1,942` tokens** (`13.9` tools) | `1,892` / `2,606` | `5,278` (`1,532` core) | **26 / 36** |
| Lexical + recent fallback (`--words-only`, used in CI) | **69 / 71 (`97.2%`)** | **`1,633` tokens** (`11.7` tools) | `1,532` / `2,300` | `5,278` (`1,532` core) | **0 / 36** |

The two unrouted cases (`multistep/visual-look-then-click` and `multistep/visual-disambiguate-som`) initially omitted `look_at_screen`; at runtime, missing-tool fallback re-offers the full toolset when needed. Semantic embeddings lift roundabout phrasing coverage from `0/36` to `26/36`.

---

## 2. Deterministic Security & Policy Gates

| Gate | Command | Result |
| --- | --- | --- |
| Indirect prompt-injection & taint fuzzer | `npm run eval -- --fuzz` (`500` cases, seed `20261122`) | **500 / 500 passed** (`0` unauthorized allows, `0` unseen leaks): `web` 100/100, `agenda` 100/100, `notices` 100/100, `documents` 100/100, `fleet` 100/100 |
| Static policy & rule-conflict audit | `npm run eval -- --audit` | **PASS** (`critical=0, warning=0, info=0`) |
| Offline typecheck, lint & Vitest suite | `npm run check` | All typecheck (`tsconfig.node.json` + `tsconfig.web.json`), ESLint, and Vitest specs green |

---

## 3. Live GPU Evaluation Across Model Tiers (`163` Cases)

All three built-in tiers were benchmarked on the full 163-case suite (`--fitting-tools`):

| Category | Cases | `bench-small-base` (Qwen3.5 4B) | `bench-standard` (Qwen3.5 9B) | `bench-large` (Qwen3.8 27B) |
| --- | --- | --- | --- | --- |
| Tool choice & arguments | 47 | 91.5% (resisted 100%) | 93.6% (resisted 100%) | **95.7%** (resisted 100%) |
| Follow-through honesty | 15 | 60.0% | 80.0% | **100.0%** |
| Safe under injected text | 15 | 86.7% (did not try 87%) | 86.7% (did not try 100%) | **100.0%** (did not try 100%) |
| Character & form | 18 | 66.7% | **88.9%** | 83.3% |
| Using what she knows | 17 | 82.4% | 64.7% | **88.2%** |
| Reasoning & knowledge | 35 | **97.1%** | 94.3% | 85.7% |
| Multi-step | 16 | **87.5%** | 75.0% | 81.3% |
| **Overall (mean of categories)** | **163** | **81.7% (`82%`)** | **83.3% (`83%`)** | **90.6% (`91%`)** |
| **Nothing leaked** | **163** | **100%** | **100%** | **100%** |

### Live Grammar-Guarded Re-Verification (`Qwen3.5-9B`, `grammarGuard.ts` Active, `standard-grammar-live`)

Re-ran the full 163-case RTX PRO 4500 evaluation with GBNF schema hardening (`additionalProperties: false`), `StreamingJsonParamGuard`, and `ToolLoopGuard` active in `src/core/brain.ts` (`8.0 minutes`, `--fitting-tools`):

- **Overall (mean of categories):** **`85%`** *(Tools `91%`, Follow-through `73%`, Safe under injected text **`100%`**, Character `78%`, Using what she knows **`82%`**, Reasoning & knowledge **`97%`**, Multi-step `75%`)* — **+1.7 pts over the unguarded 9B baseline (`83.3% -> 85%`)** with **`100%` Nothing Leaked** and **`100%` resistance under injected text**.
- **Latency & footprint:** `1.3 s` load, **`1.85 s` median TTFT**, **`116 tok/s`** writing speed, `6,262 / 6,270 MiB` own VRAM (`3,285 MiB` RSS).

### Post-UX-Sprint Live GPU Regression Re-Verification (`post-ux-standard` & `post-ux-small`)

After updating `src/core/engine.ts`, `src/core/brain.ts`, `src/core/permissions.ts`, and posture/rollback/cancellation hooks, re-ran both full 163-case RTX PRO 4500 GPU evaluations (`--fitting-tools`):

| Category / Metric | `post-ux-small` (Qwen3.5 4B vs `bench-small-base`) | `post-ux-standard` (Qwen3.5 9B vs `standard-grammar-live`) |
| --- | --- | --- |
| Tool choice & arguments | **`91%`** (`0 pts`, resisted **`100%`**) | `83%` (resisted **`100%`**) |
| Follow-through honesty | **`87%`** (`+27 pts`) | `67%` (`-7 pts`, within noise) |
| Safe under injected text | `87%` (did not try `93%`, `+7 pts`) | **`100%`** (did not try **`100%`**) |
| Character & form | `78%` (`+11 pts`, within noise) | **`94%`** (`+17 pts`) |
| Using what she knows | `71%` (`-12 pts`, within noise) | `82%` (`0 pts`) |
| Reasoning & knowledge | **`97%`** (`0 pts`) | **`100%`** (`+3 pts`) |
| Multi-step | `81%` (`-6 pts`, within noise) | `69%` (`-6 pts`, within noise) |
| **Overall (mean)** | **`85%`** (**`+3 pts`**) | **`85%`** (`0 pts`) |
| **Nothing leaked** | **`100%`** (`0 pts`) | **`100%`** (`0 pts`) |
| **Median TTFT / Speed** | **`1.06 s`** / **`183 tok/s`** (`-0.08 s` / `+12 tok/s`) | **`1.97 s`** / **`107 tok/s`** |
| **Own VRAM (peak) / RSS** | `3,992 / 4,000 MiB` / `3,103 MiB` (`-180 MiB`) | `6,262 / 6,270 MiB` / `3,118 MiB` (`-167 MiB`) |

### Latency, Throughput & Resource Footprint

| Metric | `bench-small-base` (4B) | `bench-standard` (9B) | `bench-large` (27B) |
| --- | --- | --- | --- |
| Total 163-case suite runtime | `6.94 min` | `8.34 min` | `25.35 min` |
| Model load time | `2.09 s` | `3.27 s` | `7.96 s` |
| First reply after load | `1.94 s` | `3.06 s` | `5.20 s` |
| Median time-to-first-word (TTFT) | **`1.15 s`** | `2.02 s` | `4.30 s` |
| Writing speed | **`170.8 tok/s`** | `113.6 tok/s` | `38.9 tok/s` |
| First-turn prompt tokens | `5,246` | `5,250` | `5,283` |
| Own VRAM (loaded / peak) | `3,992 / 4,000 MiB` | `6,262 / 6,270 MiB` | `16,792 / 16,802 MiB` |
| Whole GPU peak (incl. desktop) | `6,390 MiB` | `8,134 MiB` | `18,629 MiB` |
| Process peak RSS | `3,283 MiB` | `2,698 MiB` | `16,495 MiB` |
| Follow-through checks (acted / corrected) | `4` checked (`2` acted, `8` corrected) | `2` checked (`1` acted, `4` corrected) | `1` checked (`0` acted, `1` corrected) |

---

## 4. End-to-End GPU LoRA Distillation Pass & Before/After Comparison

We executed an end-to-end distillation run on the RTX PRO 4500 GPU using real trace exports (`npm run export-pairs`), `train/lora.py`, `convert_lora_to_gguf.py`, and `npm run eval -- --lora ... --compare` to verify the pipeline empirically rather than shipping untested weights.

### Dataset & Training Run

- **Exported dataset (`npm run export-pairs -- --format sft --teacher-only bench-small-base bench-standard bench-large`):** `152` SFT examples (`144` train / `8` held-out with `seed=7`, `held_out=0.05`) drawn from clean teacher trajectories (`bench-standard`: 72, `bench-large`: 75) plus verified claim-corrected preference pairs (`5` from `bench-small-base`, `3` from `bench-standard`).
- **Training (`train/lora.py`, `Qwen3.5-4B` in `bfloat16`):** LoRA rank `16`, alpha `32`, dropout `0.05`, `lr=1e-4`, cosine warmup `6%`, gradient accumulation `8`, `2` epochs (`36` optimizer steps), `30.5M` trainable parameters.
- **Held-out loss trajectory:**
  - Step 0 (baseline): `2.2258`
  - Step 4: `1.2281`
  - Step 8: `0.9530`
  - Step 12: `0.8326`
  - Step 16: `0.8098`
  - Step 20: `0.7751`
  - **Step 24 (best checkpoint):** **`0.7740`**
  - Step 36 (final): `0.7832`
- **GGUF conversion:** `convert_lora_to_gguf.py` produced `small-lora.gguf` (`117 MiB`, sha256 `1044ee4dbb4a...`).

### Before vs After Small-Brain Evaluation (`163` Cases)

| Category | `bench-small-base` | `bench-small-distilled` | Delta |
| --- | --- | --- | --- |
| Tool choice & arguments | 91% | 28% | **-64 pts** |
| Follow-through honesty | 60% | 20% | **-40 pts** |
| Safe under injected text | 87% | 20% (did not try: 100%) | **-67 pts** (`+13 pts` resistance, within noise) |
| Character & form | 67% | 78% | `+11 pts` (within noise) |
| Using what she knows | 82% | 53% | **-29 pts** |
| Reasoning & knowledge | 97% | 89% | **-9 pts** |
| Multi-step | 88% | 0% | **-88 pts** |
| **Overall (mean)** | **82%** | **41%** | **-41 pts** |
| **Nothing leaked** | **100%** | **100%** | `0 pts` |

- **Resource delta:** Peak own VRAM increased `+222 MiB` (`4,000 -> 4,222 MiB`), writing speed slowed `-38 tok/s` (`171 -> 133 tok/s`), and median TTFT shifted `1.15 -> 1.27 s`.
- **Root-Cause Diagnosis (Why the Real GPU Eval Caught This):**
  1. `src/core/trainingExport.ts` (`formatQwenSft`) currently serializes training prompts with a terse `Available tools: ...` line and bare `<tool_call>\n{...}\n</tool_call>` blocks **without** mirroring `node-llama-cpp`'s `QwenChatWrapper` `# Tools` `<tools>{JSON schema}</tools>` preamble or `Qwen3.5`'s `<think>...</think>` span structure.
  2. Supervising directly from `<|im_start|>assistant\n` into raw tool tags with `144` training examples at `lr=1e-4` over-fit formatting tokens: at inference under `QwenChatWrapper`, the adapter either emitted empty responses (`"she said nothing"`) when `node-llama-cpp` suppressed/aborted generation or emitted malformed inline text tool calls (e.g., `<tool_call> {"name":"run_command",...}`) instead of valid schema invocations.
- **Release Decision:** Because `npm run eval -- --compare` caught this regression on real hardware, **no distilled LoRA adapter is shipped or enabled by default**. Astra Navi Desktop ships against the verified baseline GGUF checkpoints (`82%` / `83%` / `91%`), while `formatQwenSft` template alignment with `QwenChatWrapper` + larger multi-turn training corpora remain prerequisite fixes before shipping tuned student adapters.

---

## 5. Local Field Checks & Honest Verification Scope

### Verified on This Linux Workstation

- **Packaged Electron Bundle (`electron-builder --linux dir`):** Boot-testing `dist/linux-unpacked/astra-navi-desktop` inside `scripts/test-desktop.sh` (`kwin_wayland`) initially caught `ERR_DLOPEN_FAILED: libvips-cpp.so.8.17.3` because `@img/sharp-libvips-linux-x64` stayed inside `app.asar`; extending `electron-builder.yml` `asarUnpack` with `**/*.so`, `**/*.so.*`, `**/*.dll`, `**/*.dylib`, and `node_modules/@img/**` resolved packaged boot with **0 uncaught exceptions**, unpacked `libvips-cpp.so.8.17.3`, resolved native Rust `linux-hands` (`pong`, `linux-hands 1.0.0`), verified compiled renderer symbols in `app.asar`, and omitted `win_hands.ps1`, `ai-navigator.blend`, `store/`, `tests/`, `evals/`, and `ios-app/`.
- **Live Interactive Wayland Chromium UX Checks (`scripts/test-desktop.sh`):** Verified multi-turn chat `.code-copy-btn` -> `"Copied"` + Electron async `clipboard.writeText`/`readText` round-trip, `.log-turn-actions` (`Edit & Resend` and `Forget Last Turn`), `High-Impact` risk badge + raw command preview + `Enter`-confirm refusal with guard hint + `Esc` deny, and non-destructive `files:drop` attachment/notice routing.
- **Live End-to-End Integration Dogfooding:** Verified on RTX PRO 4500 Linux host: `Qwen3.5-9B` driving two real stdio MCP subprocesses (`localfs`, `gitinfo`) under `grammarGuard.ts` + `ToolLoopGuard`, `profileBackup.ts` export/wipe/restore parity, `StartupGuard` (`safeMode.ts`) two-crash recovery (`0600`), and zero-Python `OnnxVoice` (`Kokoro-82M`) synthesis (`63,600` finite samples @ `24 kHz`).
- **Android Companion APK (`scripts/build-android.sh`):** Compiled and locally signed `phone-app/build/astra-navi.apk` (`56K`, `app.astranavi.station`, deep link `astranavi://station`).
- **Live Ephemeral SSH Enrollment (`scripts/test-fleet-askpass.sh`):** Spawned an unprivileged local `/usr/bin/sshd`, ran interactive `SSH_ASKPASS` (`LET_IN`) key enrollment with a passphrase-protected ED25519 bootstrap key, and verified subsequent key-based SSH login (`exit 0`).
- **Windows Hands NativeAOT Project (`hands/win-hands-native/`):** Compiles and smoke-tests `-r win-x64` NativeAOT `win-hands.exe` on `windows-latest` in GitHub Actions.
- **Browser DOM Bridge (`browser-bridge/`):** Unit and loopback integration tests (`tests/semanticBridge.test.ts`) verified 32-bit LE Native Messaging framing, strict exact-origin allowlisting, and `NativeBrowserDomClient` IPC transport.
- **Release Dry-Runs:** `npm run package:dry` and `npm run publish:dry` verified edition split, Flatpak manifest, Steam VDFs, and Electron Builder configuration.

### Not Executed on Physical Hardware Here (Remaining Release Matrix)

- **Blank Windows 11 Clean-Room VM (`scripts/verify-clean-windows.ps1`):** Full installer walkthrough, `.pmx` + `.vrm` rendering, Notepad UIA automation, and live fullscreen DirectX/Vulkan VRAM yield must still be executed on a blank physical/VM Windows 11 image before general release.
- **Physical Android Handset LAN Pairing:** QR scan (`astranavi://station?...`) + mDNS `_astranavi._tcp.local` pairing and 64-hex TLS pinning must be verified interactively on a physical Android phone over local Wi-Fi.
- **Apple Hardware (`macos.ts`, `mlxEngine.ts`, `ios-app/`) & Live Steamworks AppID (`workshop.ts`):** Uncompiled/unverified on macOS/iOS Apple Silicon devices and unverified against a live Steamworks AppID; kept strictly labeled as **Preview / Post-Launch**.
- **Live-Room Acoustic AEC & Wake-Word Microphone Testing:** Echo cancellation (`src/core/voice/aec.ts`) and wake-word matching (`src/core/wakeName.ts`) remain synthetic-tested here rather than open-speaker room audio.

---

## 6. Rolling Model Catalog, Vetted One-Click Presets & Grammar/Loop Stress Gates

_Generated locally by `npm run benchmark:catalog -- --write-report` (2026-11-24). Live GPU metrics reflect real RTX PRO 4500 Blackwell runs; newer MoE/72B presets remain marked `pending_gpu` until measured on live GPU hardware._

### Rolling Open-Weight Catalog & Sizing Matrix

| Preset ID | Tier | Architecture / Params | Default Quant & Min VRAM | 16k KV Cache | Benchmark Status |
| --- | --- | --- | --- | --- | --- |
| `qwen3.5-4b` | small | dense (4B / 4B active) | `Q4_K_M` (`4 GB` min) | `1.13 GB` (std) | Verified (**81.7%**, `170.8 tok/s`) |
| `qwen3.5-9b` | standard | dense (9B / 9B active) | `Q4_K_M` (`7 GB` min) | `1.50 GB` (std) | Verified (**83.3%**, `113.6 tok/s`) |
| `qwen3.8-27b` | large | dense (27B / 27B active) | `Q4_K_M` (`19 GB` min) | `2.25 GB` (std) | Verified (**90.6%**, `38.9 tok/s`) |
| `qwen3-30b-a3b-moe` | large | moe (30B / 3B active) | `Q4_K_M` (`20 GB` min) | `1.50 GB` (std) | `pending_gpu` (needs live GPU eval) |
| `qwen3.5-72b` | xl | dense (72B / 72B active) | `Q4_K_M` (`48 GB` min) | `5.00 GB` (std) | `pending_gpu` (needs live GPU eval) |
| `qwen3.5-120b-a16b-moe` | xl | moe (120B / 16B active) | `IQ4_XS` (`66 GB` min) | `2.50 GB` (std) | `pending_gpu` (needs live GPU eval) |

### Deterministic Grammar-Constrained Decoding & Loop-Guard Verification

- **Indirect Prompt-Injection & Taint Fuzzer (`evals/fuzz.ts`, seed `20261122`):** **500/500 passed** (`0` unauthorized allows, `0` unseen leaks).
- **Grammar & Loop-Breaker Stress Suite (`scripts/benchmark-catalog.ts`):** **24/24 passed** (nested JSON GBNF compilation, strict `additionalProperties: false` enforcement, streaming repetition abort, exact repeat breaker, `A <-> B` oscillation detector, consecutive failure breaker, and turn cap).

---

## 7. Experimental Branch R&D Benchmarks (Post-v1)

_Collected on the isolated `experimental` branch (`main` remains frozen for v1 release)._

### 7.1 `Qwen3.5` Template-Aligned Router LoRA v2 vs. v1 & Baseline (`163` Cases)

Aligning `src/core/trainingExport.ts` (`chatTemplate: "qwen3.5"`) with `node-llama-cpp`'s `QwenChatWrapper` `# Tools` / `<think>\n\n</think>\n\n<function=NAME>` format and filtering exports strictly to modern `--fitting-tools` trajectories (`276` train / `15` held-out, rank `8`, alpha `16`, `lr=3e-5`, `1.5` epochs, `15.2M` trainable params in `bfloat16`) dropped initial held-out loss from `2.2258` (v1) to `1.0116` (step 0) -> **`0.4065`** (step 52 best checkpoint):

| Category / Metric | `bench-small-distilled` (v1) | `exp-small-lora-v2` (v2) | `post-ux-small` (Base 4B) | Delta (v2 vs Base) |
| --- | --- | --- | --- | --- |
| Tool choice and arguments | `28%` | `81%` | **`91%`** (`resisted 100%`) | `-11 pts` |
| Follow-through honesty | `20%` | `80%` | **`87%`** | `-7 pts` (within noise) |
| Safe under injected text | `20%` | `67%` (`did not try: 100%`) | **`87%`** (`did not try: 93%`) | `-20 pts` |
| Character and form | `78%` | **`83%`** | `78%` | **`+6 pts`** (within noise) |
| Using what she knows | `53%` | **`76%`** | `71%` | **`+6 pts`** (within noise) |
| Reasoning and knowledge | `89%` | **`97%`** | **`97%`** | `0 pts` |
| Multi-step | `0%` | `63%` | **`81%`** | `-19 pts` |
| **Overall (mean of categories)** | `41%` | `78%` (`+37 pts` over v1) | **`85%`** | **-6 pts** |
| **Nothing leaked** | `100%` | `98%` | **`100%`** | **-2 pts** |
| **Median TTFT / Writing speed** | `1.27 s` / `133 tok/s` | `1.76 s` / `145 tok/s` | **`1.06 s` / `183 tok/s`** | `+0.69 s` / `-37 tok/s` |
| **Own VRAM (loaded / peak)** | `4,222 MiB` peak | `4,154 / 4,164 MiB` | **`3,992 / 4,000 MiB`** | `+164 MiB` peak |

- **Shipping Gate Outcome:** Although template alignment recovered **+37 pts** (`41% -> 78%`) and gained +6 pts on Character & Memory, `exp-small-lora-v2` still trailed `post-ux-small` (`78% < 85%`) and slipped to `98%` Nothing Leaked (`-2 pts`, failing `injection/ja-page-reminder` and two other safety edge cases). **Per the shipping gate, no LoRA weights are shipped to `astra-navi-supporter`.** Next iteration should expand individual parameter tags beyond single `<parameter=params>` wrapping during SFT export.

### 7.2 Hot-Swappable Domain Specialist Adapters (`scripts/benchmark-lora-agents.ts`)

Benchmarked live on RTX PRO 4500 against frozen `Qwen3.5-4B-Q4_K_M.gguf` (`795 ms` base load) with `fleet-systems.lora.gguf` (`97` train / `5` held-out, loss `0.9793 -> 0.7170`, `59 MiB`) and `logistics-scheduling.lora.gguf` (`105` train / `6` held-out, loss `0.9100 -> 0.5155`, `59 MiB`):

| Domain Adapter | Scoped Tools | Est. Prompt Tokens (vs `5,278` All-Tools) | Swap Latency | Task Accuracy (Frozen Base vs Hot-Swapped) |
| --- | --- | --- | --- | --- |
| `fleet-systems` | `4` | **`650` tokens (`-4,628`, `-87.7%`)** | `10–20 ms` | `1/2` vs `1/2` (`remote` vs `run_command` choice) |
| `logistics-scheduling` | `6` | **`920` tokens (`-4,358`, `-82.6%`)** | `10–21 ms` | `2/2` vs `2/2` |
| **Total (4 tasks)** | `4–6` | **-82.6% to -87.7% prompt budget** | **`15 ms` avg** | **`3/4` vs `3/4`** (`0` swap failures) |

### 7.3 Zero-Python CPU Voice R&D (`scripts/benchmark-voice-rd.ts`)

Measured on CPU-only (zero Python subprocess, `0 MB` GPU VRAM) with cached `onnx-community/Kokoro-82M-v1.0-ONNX` (`q8`) via `UltraLightOnnxVoice` + `extractExpressiveCues()`:

| Metric | Measured CPU Value (`kokoro-82m` `q8`) |
| --- | --- |
| Cold model load (`warm()`) | `412.8 ms` |
| First-audio clause latency | `1,990.9 ms` (`2` streamed clauses) |
| Total synthesis time vs audio duration | `4,751.6 ms` for `8,175.0 ms` audio |
| **Real-Time Factor (RTF)** | **`0.581`** (faster than real-time on CPU) |
| Expressive cue extraction (`20 ms` hops) | **`3.322 ms` / sec of audio** (`409` cue frames) |
| Process RSS memory | `481 MB` |

---

## 8. Post-v1 7-Track R&D Benchmarks & Multi-Node Verification (`experimental`)

_Measured cleanly on the isolated `experimental` branch (`main` remains frozen for v1 release)._

### 8.1 GPU KV-Cache Quantization & Speculative Decoding (`scripts/benchmark-speculative-kv.ts`)

Measured on live RTX PRO 4500 GPU against `Qwen3.5-9B-Q4_K_M.gguf` (`8192` context, Flash Attention on, `160` generated tokens):

| Configuration | Cold Load | VRAM Delta | Median TTFT | Decode Throughput | Notes |
| --- | --- | --- | --- | --- | --- |
| `9B` Baseline (`FP16` KV) | `1286 ms` | `5,698 MiB` | `103 ms` | `78 tok/s` | Baseline reference |
| `9B` Lean (`Q8_0` KV) | `999 ms` | `5,580 MiB` (`-118 MiB`) | `43 ms` | **`115 tok/s` (`+47.4%`)** | Cuts TTFT `-58%`, default medium tier |
| `9B` Ultra-Lean (`Q4_0` KV) | `985 ms` | `5,516 MiB` (`-182 MiB`) | `45 ms` | **`115.5 tok/s` (`+48.1%`)** | Tight VRAM budget configuration |
| `9B` + `4B` Speculative Draft | — | — | `97 ms` | `49.1 tok/s` | Draft ~44% of target slows decode -> enforced `<= 25%` VRAM draft cap in `selectSpeculativeDraft()` |

### 8.2 CPU Voice Engine Shootout (`scripts/benchmark-voice-shootout.ts`)

Measured on CPU-only (`0 MB` VRAM):

| Voice Preset / Engine | Load Latency | Synthesis Time | Audio Duration | Real-Time Factor (RTF) |
| --- | --- | --- | --- | --- |
| `astra` (`af_heart` `q8`, `1.00x`) | `260.9 ms` | `2,917.2 ms` | `5,625 ms` | **`0.519`** |
| `bright` (`af_bella` `q8`, `1.06x`) | `216.1 ms` | `2,475.4 ms` | `5,900 ms` | **`0.420`** |

- **Prosody Script & Native Contracts:** `parseProsodyScript` (`[emphasis] All checks passed! [pause 300ms] [whisper] Standing by. [sigh]` -> `speakText: "All checks passed! Standing by."`, `gainScale: 0.55`, `2` cues), `LlamaCppSpeechBackend` (`/v1/audio/speech`, SSRF-gated LAN-only), and `ChatterboxNanoVoice` (`1200` samples @ clamped exaggeration `1.0`) verified.

### 8.3 Live 3-Node Proxmox LAN Encrypted Sync & Homelab Verification (`scripts/test-proxmox-multinode.ts`)

Tested across three live hosts on the `192.168.50.0/24` LAN bridge (`vmbr0` on Proxmox host `claude@192.168.50.14` with two ephemeral Debian 13 LXC peers `CT 291` at `192.168.50.75` and `CT 292` at `192.168.50.95` paired to the local desktop workstation):

- **3-Node AES-256-GCM + Ed25519 LWW CRDT Convergence:** Workstation <-> `CT 291` <-> `CT 292` converged conflicting settings/notes, tombstones, and telemetry keys in **`61 ms`**.
- **Tamper, Forgery & WAN SSRF Resistance:** Bit-flipped AES-GCM ciphertext and untrusted sender signatures returned HTTP **`403`** across real LAN sockets; public IP `8.8.8.8` blocked before opening a socket (`isPrivateLanHost`).
- **Sanitized Session Handoff:** `sk-live-...`, `ghp_...`, and raw `screenCapture` fields were stripped/redacted (`[redacted-secret]`) prior to arriving on `CT 292`.
- **Live Proxmox Host Telemetry (`plugins/homelab-ops`):** Read-only `sudo zpool status -x` parsed as **`online`** (`heavyJobAllowed: true`, `outsideText: true`). Both ephemeral test containers (`291`, `292`) were stopped and destroyed after verification with all pre-existing VMs/CTs untouched.

### 8.4 Chaos Fuzzing, Multi-Turn Simulator, Android Build & Model Regression Matrix

- **Native Hands Chaos Fuzzer (`scripts/fuzz-native-hands.ts`):** **`175/175` chaos frames** (`150` persistent stream + `25` isolated binary/invalid-UTF-8/truncated EOF) against compiled `hands/linux-hands-native/target/release/linux-hands` -> `175` structured responses, **`0` crashes**, **`0` non-zero exits**, plus `hands/win-hands-native/Program.cs` static audit **PASS**.
- **Multi-Turn Synthetic User Simulator (`scripts/run-multiturn-eval.ts`):** **`5/5` scenarios passed (`42` turns)** covering mid-stream fact contradictions, cross-turn outside-text taint escalation, self-consistency plan consensus vs. hands-off, semantic cache numeric slot guards, and away-mode sensor/secret isolation.
- **Signed Opt-In Plugin Pack (`npm run eval -- --plugin`):** `local-vault-rag`, `lan-game-copilot`, `homelab-ops`, `home-assistant-mqtt`, and `creative-pipeline` — **all `5` plugins passed `5/5` bundled eval cases (`25/25`)**.
- **Android Companion APK (`scripts/build-android.sh`):** Built `phone-app/build/astra-navi.apk` (`64K`, `version 0.1.0`, `build 29924884`, `javac --release 17 -Xlint:all -Werror`, Android API 35) with homescreen Voice Widget, Quick Settings Push-to-Talk Tile, and non-exported inline notification approval actions.
- **Model Regression Matrix (`scripts/benchmark-catalog.ts --matrix`, 16k context KV in GB):**

| Preset | Architecture | `f16` KV | `f8_e4m3` KV | `q8_0` KV | `q4_0` KV | `tq4` KV | `tq3` KV | Draft @ 8 GB Spare |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `qwen3.5-4b` | `4B` dense | `1.125` | `0.585` | `0.619` | `0.338` | `0.315` | `0.236` | `none` |
| `qwen3.5-9b` | `9B` dense | `1.500` | `0.780` | `0.825` | `0.450` | `0.420` | `0.315` | `qwen3.5-1.7b` (`1.45 GB`) |
| `qwen3.8-27b` | `27B` dense | `2.250` | `1.170` | `1.237` | `0.675` | `0.630` | `0.473` | `qwen3.5-4b` (`2.9 GB`) |
| `qwen3-30b-a3b-moe` | `30B` MoE | `1.500` | `0.780` | `0.825` | `0.450` | `0.420` | `0.315` | `qwen3.5-4b` (`2.9 GB`) |
| `qwen3.5-72b` | `72B` dense | `5.000` | `2.600` | `2.750` | `1.500` | `1.400` | `1.050` | `qwen3.5-4b` (`2.9 GB`) |
| `qwen3.5-120b-a16b-moe` | `120B` MoE | `2.500` | `1.300` | `1.375` | `0.750` | `0.700` | `0.525` | `qwen3.5-4b` (`2.9 GB`) |

### 8.5 Live Cross-OS Proxmox VM Verification (Android & Windows 11 Pro)

Executed against newly provisioned Proxmox test VMs (`293` and `294`) on `192.168.50.0/24` (pre-existing VMs/CTs untouched; test VMs stopped and temporary ISOs/files cleaned up after verification):

- **Windows 11 Pro VM `294` (`astra-test-win11`, `192.168.50.2`, `Microsoft Windows 11 Pro` `10.0.26300`, Build `26300.9457` / `26H2` x64):**
  - Standalone `.NET 9` single-file `win-hands.exe` (`70,996,496` bytes): verified `ping` (`{"alive":true,"platform":"win32","arch":"x64","nativeAot":true}`, exit `0`), `version` (`{"name":"win-hands-native","version":"0.1.0","platform":"win32"}`, exit `0`), `volume-get` (`{"percent":50,"muted":false}`, exit `0`), `gpu-vram` (`null` on QEMU VGA adapter, exit `0`).
  - Interactive Desktop Session 1 (`schtasks /RU astra /IT`): `layout` enumerated real Win32 windows (`WindowsTerminal` `1129×635`, `explorer` `Program Manager` `1280×800` across `1280×800` desktop) and `game-state` returned `{"code":6,"state":"QUNS_ACCEPTS_NOTIFICATIONS","process":"SearchHost"}`.
  - **`--serve` 30-frame chaos fuzz batch:** `30/30` structured `RpcResponse` JSON lines in **`101 ms`** (`exit 0`, `0` crashes), verifying `UIA_FALLBACK`, `"Missing verb."`, malformed JSON error handling, unsupported verb errors, `wasapi-check`, and `wasapi-streams`.
  - **Bidirectional Win11 <-> Linux `PeerStateSyncEngine` LAN sync (`192.168.50.2` <-> `192.168.50.40`):** Windows 11 PowerShell retrieved `/sync/state` over `ssh -R 48025` (HTTP `200`, `362 ms` RTT, `cipherB64Len=536`, `sigB64Len=88`, secret redacted and `screenCapture` stripped) and received HTTP `403` on tampered `/sync/merge`; direct un-tunneled Linux `syncWithLanPeer` -> `http://192.168.50.2:48025/sync/merge` succeeded with HTTP `200` (`1,777 ms` cold `HttpListener` RTT, `cipherB64Len=460`), while `8.8.8.8` was blocked before connect by `isPrivateLanHost`.
- **Bliss OS VM `293` (`astra-test-android14`, `192.168.50.237`, `Bliss-Surface-v14.10.3-x86_64-OFFICIAL-foss-20241013.iso`, runtime `ro.build.version.release=11` / `sdk=30` / `abi=x86_64` / kernel `6.1.112-gloria-surface-xanmod1`):**
  - Downloaded `phone-app/build/astra-navi.apk` (`62,239` bytes, sha256 `2689e71a1d808a594be808d7435d2d2db3efccb276c25fc82bebd76904369cc5`) over LAN HTTP (`192.168.50.14:48003`); `pm install -r /data/local/tmp/astra-navi.apk` -> `Success`.
  - `dumpsys package app.astranavi.station` confirmed `.MainActivity`, `.VoiceWidgetProvider`, and `.PushToTalkTileService (permission android.permission.BIND_QUICK_SETTINGS_TILE)` registered.
  - `am start -W -n app.astranavi.station/.MainActivity --ez app.astranavi.station.START_VOICE true` cold-launched cleanly (`Status: ok`, `LaunchState: COLD`, `TotalTime: 772` ms, `WaitTime: 776` ms, `PID=4030` in `mResumedActivity`), LAN ping returned `pong-from-lan`, and `logcat -d -s AndroidRuntime:E` had zero fatal exceptions.

---

## 9. Consolidation, 2-Winner Voice Pruning, Security Audit & LoRA v3 (`experimental`)

### 9.1 `QwenChatWrapper`-Exact LoRA v3 (`exp-small-lora-v3`) vs. v2, v1 & Baseline (`163` Cases)

Aligning `src/core/trainingExport.ts` + `scripts/export-pairs.ts` byte-for-byte with runtime `QwenChatWrapper({ variation: "3.5" })` (`<parameter=params>\n{JSON}\n</parameter>`, `JSON.stringify` `<tool_response>`, real `buildSystemPrompt`, and `[form]` typed suffix without forced empty `<think>\n\n</think>`) and training with `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True --max-tokens 6144` (`276` train / `15` held-out, `36` > `6144` skipped, rank `8`, alpha `16`, `lr=1.5e-5`, `1.5` epochs, `15.2M` trainable params in `bfloat16`) reduced held-out loss monotonically from **`1.1843`** (step 0) -> **`0.5076`** (step 52 best, exported to `59 MB` / `400`-tensor GGUF):

| Category / Metric | `bench-small-distilled` (v1) | `exp-small-lora-v2` (v2) | `exp-small-lora-v3` (v3) | `post-ux-small` (Base 4B) | Delta (v3 vs Base) |
| --- | --- | --- | --- | --- | --- |
| Tool choice and arguments | `28%` | `81%` | `83%` (`resisted 100%`) | **`91%`** (`resisted 100%`) | `-9 pts` |
| Follow-through honesty | `20%` | `80%` | **`93%`** | `87%` | **`+7 pts`** (within noise) |
| Safe under injected text | `20%` | `67%` | **`87%`** (`did not try: 93%`) | **`87%`** (`did not try: 93%`) | `0 pts` |
| Character and form | `78%` | **`83%`** | `67%` | `78%` | `-11 pts` (within noise) |
| Using what she knows | `53%` | **`76%`** | `71%` | `71%` | `0 pts` |
| Reasoning and knowledge | `89%` | **`97%`** | **`97%`** | **`97%`** | `0 pts` |
| Multi-step | `0%` | `63%` | **`88%`** | `81%` | **`+6 pts`** (within noise) |
| **Overall (mean of categories)** | `41%` | `78%` | `84%` (`+6 pts` vs v2) | **`85%`** | **-1 pt** |
| **Nothing leaked** | `100%` | `98%` | **`100%`** (`+2 pts` vs v2) | **`100%`** | **`0 pts`** |
| **Median TTFT / Writing speed** | `1.27 s` / `133 tok/s` | `1.76 s` / `145 tok/s` | `1.32 s` / `148 tok/s` | **`1.06 s` / `183 tok/s`** | `+0.26 s` / `-35 tok/s` |
| **Own VRAM (loaded / peak)** | `4,222 MiB` peak | `4,154 / 4,164 MiB` | `4,154 / 4,164 MiB` | **`3,992 / 4,000 MiB`** | `+164 MiB` peak |

- **Shipping Gate Outcome:** LoRA v3 recovered `+6 pts` overall (`78% -> 84%`), `+13 pts` Follow-through Honesty (`80% -> 93%`), `+20 pts` Injection Safety (`67% -> 87%`), `+25 pts` Multi-step (`63% -> 88%`), and restored **`100%` Nothing Leaked**. Because overall mean `84%` remains 1 pt below the `>= 85%` shipping bar, **`overlay/assets/lora/` stays omitted in `astra-navi-supporter`**.

### 9.2 Pruned 2-Winner Voice Shootout & Real-Hardware Re-Runs

- **Pruned 2-Winner Voice Architecture (`scripts/benchmark-voice-shootout.ts`, CPU `0 MB` VRAM):** Deleted `experimentalUltraLightVoice.ts`, `llamaSpeechBackend.ts`, and `scripts/benchmark-voice-rd.ts`. Live Kokoro (`kokoro-js` `q8`) verified EN-only (`kokoroEnSupported: true`, `kokoroJaSupported: false`, `kokoroZhSupported: false`; JA/ZH route to `qwen3-tts-0.6b`):
  - `astra` (`af_heart`, `q8`): `232.1 ms` load, `1,684.3 ms` TTFA, `3,431.8 ms` synth / `6,500 ms` audio (**`0.528` RTF**), `2` clauses, `326` cue frames (`3.39 ms/s`), `469 MB` RSS, RMS `-23.7 dB`, peak `0.588`, clipped `0`.
  - `bright` (`af_bella`, `q8`): `217.1 ms` load, `1,869.7 ms` TTFA, `2,739.6 ms` synth / `6,450 ms` audio (**`0.425` RTF**), `2` clauses, `323` cue frames (`3.097 ms/s`), `727 MB` RSS, RMS `-23.3 dB`, peak `0.529`, clipped `0`.
  - `calm` (`bf_emma`, `q8`): `221 ms` load, `2,226.9 ms` TTFA, `2,245.2 ms` synth / `5,275 ms` audio (**`0.426` RTF**), `1` clause, `264` cue frames (`3.461 ms/s`), `982 MB` RSS, RMS `-21.2 dB`, peak `0.627`, clipped `0`.
  - `Qwen3StreamingTtsBackend` loopback PCM16 transport: `8` chunks (`24,000` samples), `5.6 ms` TTFA, `52.1 ms` total; `detectCodeSwitchSpans` split EN/JA cleanly (`[{en:"Hello"},{ja:"世界"},{en:"and"},{ja:"こんにちは!"}]`).
- **GPU KV & Speculative Shootout Re-Run (`scripts/benchmark-speculative-kv.ts`):** `9B FP16 KV` (`2,528 ms` load, `5,698 MiB` VRAM, `44 ms` TTFT, `115.2 tok/s`), `9B Q8_0 KV` (`908 ms` load, `5,580 MiB`, `44 ms`, **`115.4 tok/s`**), `9B Q4_0 KV` (`989 ms` load, `5,514 MiB`, `44 ms`, `110.4 tok/s`), `9B + 4B` draft (`98 ms` TTFT, `48 tok/s`).
- **Proxmox 3-Node LAN Sync (`scripts/test-proxmox-multinode.ts`, CTs `291`/`292`):** Converged in **`58 ms`**, tampered & rogue rejected (`403`), WAN `8.8.8.8` blocked pre-connect, `zpool` `online`; CTs destroyed afterwards.
- **Workbench, Seams & Security Suite:** Consolidated 4 pop-outs into `workbench.html`; added `TurnHookPipeline` & `StageLayerManager` seams (`tests/integrationSeams.test.ts`); hardened `peerSync.ts`, `vaultRag.ts`, `lanVisionOffload.ts`, and `voiceCloneStudio.ts` (`tests/experimentalSecurityAudit.test.ts`). Full suite: **`125/125` test files (`2,496/2,496` tests)**, **`175/175` native hands chaos frames**, **`5/5` multi-turn scenarios (`42` turns)**, and **`7/7` plugins** (`4/4` or `5/5` per plugin).



