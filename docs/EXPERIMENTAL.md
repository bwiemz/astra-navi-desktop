# Astra Navi Desktop — Experimental Branch Roadmap & Inventory

> **Branch Policy:** All items listed here live exclusively on the `experimental` branch (`main` remains frozen at `89a1b61541851720ee4edb3aa0264180ed41ced7` in `astra-navi-desktop` and `6fafaef58ad389afc47f082ae65c2448ba0979cc` in `astra-navi-supporter` for v1.0 release stability). `git diff main -- CHANGELOG.md README.md` is intentionally empty (`CHANGELOG.md` and `README.md` match `main`).

---

## 1. Promotion Waves

Every experimental addition relative to `main` is assigned to an explicit post-v1 promotion wave:

### Wave 1 (`v1.1`) — Consolidated Workbench, Seams, 2-Tier Voice & Evaluation Upgrades
- **Unified Tabbed Workbench Window (`workbench.html`):**
  - Replaced four separate secondary Chromium windows (`mission-control.html`, `avatar-studio.html`, `policy-composer.html`, `turn-xray.html`) with one tabbed secondary Electron window (`src/renderer/workbench.html`) and left navigation rail (`Missions`, `Memory Graph`, `Policy Composer`, `Turn X-Ray`, `Audio & AEC`, `Avatar Studio`).
  - Modules: `src/shared/workbench.ts`, `src/preload/workbench.ts`, `src/main/workbenchIpc.ts`, `src/main/missionControlIpc.ts`, `src/main/studioToolsIpc.ts`, `src/shared/missionControl.ts`, `src/shared/studioTools.ts`, `src/renderer/src/workbench/{main,dom,policyComposer,turnXray,avatarStudio,audioCalibration}.ts`, `src/renderer/src/workbench/style.css`, `src/renderer/src/mission-control/{missions.ts,memory.ts,policyReplay.ts}`, `electron.vite.config.ts`, `src/main/tray.ts`, `src/main/index.ts`.
  - Animation frame pausing (`requestAnimationFrame` active only when the `Avatar Studio` tab is selected) + post-approve/resume `450 ms` UI sync.
  - **Live-Room AEC & Wake-Word Calibration Utility (`Audio & AEC` tab):** `generateCalibrationTone()` and `evaluateRoomCalibration()` (`src/core/voice/aec.ts`), `studio:run-room-calibration` IPC (`src/main/studioToolsIpc.ts`), live Web Audio probe + synthetic room loopback self-test (`renderWorkbenchAudioPanel`).
- **Feature-Flagged Runtime Seams (`TurnHookPipeline` & `StageLayerManager`):**
  - `src/core/turnHooks.ts` (`TurnHookPipeline`, `createSemanticCacheHook`, `createPlanConsensusHook`) mounted behind optional `EngineOptions.turnHooks` in `src/core/engine.ts` and `src/core/brain.ts` (zero-cost no-op when unset), integrating `src/core/semanticCache.ts` and `src/core/planConsensus.ts` and benchmarkable via `scripts/eval.ts --turn-hooks`.
  - `src/renderer/src/stageLayers.ts` (`StageLayerManager`, `createAvatarAnimatorLayer`, `createVrmaBridgeLayer`, `createStageLightingLayer`, `createCanvas2DLayer`) mounted onto `src/renderer/src/stage.ts` (`registerLayer`, `unregisterLayer`, `runStageLayers`, `dispose`), integrating `src/renderer/src/{avatarAnimator,vrmaStageBridge,stageLighting,canvas2dStage}.ts` and `src/shared/{avatar2d,gestures,spatialStage,visemes,vrma}.ts`.
- **Two-Tier Zero-Python Voice Stack & GPU Yielding:**
  - `src/core/voice/onnxVoice.ts`: Lightweight CPU-only English tier (`kokoro-82m`, `q8`/`fp32`, `splitStreamingClauses()`, `synthesizeStream()`, `OnnxVoice.disposeSharedEngines()`). Built-in presets declare honest `languages: ["en"]`; Japanese/Chinese route cleanly to the streaming multilingual tier.
  - `src/core/voice/experimentalMultilingualVoice.ts`, `src/main/voiceControl.ts`, `src/main/index.ts`: High-quality streaming & code-switch tier (`qwen3-tts-0.6b` chunked PCM16 streaming, `Qwen3AsrMultilingualClient`, `detectCodeSwitchSpans`), wired with idle/shutdown/toggle-off/backend-switch shared ONNX session cleanup and `GameWatch` fullscreen game GPU yielding (`POST /v1/tts/unload`) with transparent CPU Kokoro English fallback.
  - `src/core/voice/expressiveAudio.ts` & `src/core/voice/speechText.ts`: Acoustic F0/pause/emphasis cue extraction and prosody script parsing.
- **Packaged Wayland Workbench Dogfooding & Evaluation Gates:**
  - `scripts/dogfood-workbench-packaged.ts` (`scripts/test-desktop.sh`): Launches packaged `dist/linux-unpacked/astra-navi-desktop` on `kwin_wayland` + CDP, exercises all 6 Workbench tabs, verifies live Mission approval, Memory CRUD, Policy preview/replay, X-Ray, Audio & AEC (`19.6 dB` ERLE), and proves `39` active -> `0` off-tab `rAF` frames (`0` errors).
  - `src/core/trainingExport.ts` & `scripts/export-pairs.ts`: Byte-exact alignment with runtime `QwenChatWrapper({ variation: "3.5" })` (`<parameter=params>`, `JSON.stringify` `<tool_response>`, real `buildSystemPrompt`, `[form]` suffix).
  - `evals/multiTurnSim.ts` (decoupled from Wave 2 `peerSync` via `withoutSecrets` from `src/core/secrets.ts`), `scripts/run-multiturn-eval.ts`, `scripts/fuzz-native-hands.ts`, `tests/upgradeMigration.test.ts` + `tests/fixtures/v1.0-profile/`.
  - Operational verification & triage tooling: `scripts/soak-memory-leaks.ts`, `scripts/run-live-room-calibration.ts`, `docs/BETA_TRIAGE_PLAYBOOK.md`.
- **Android Companion Quick Controls:**
  - `phone-app/java/app/astranavi/station/{VoiceWidgetProvider,PushToTalkTileService,ApprovalActionReceiver,AlertPollerService,MainActivity}.java`, `phone-app/AndroidManifest.xml`, and layouts/resources (`voice_widget.xml`, `voice_widget_info.xml`, localized strings).

### Wave 2 (`v1.2`) — Hardened Opt-In Plugin Ecosystem, Multi-Node Sync & Adaptive Inference
- **Encrypted Multi-Node LAN Sync & Fleet Hardening:**
  - `src/core/peerSync.ts` (AES-256-GCM + Ed25519 LWW CRDT + replay-nonce protection + secret scrubbing), `scripts/test-proxmox-multinode.ts`.
- **Opt-In Local Vault & LAN Offload Backends:**
  - `src/core/vaultRag.ts` (approved-root symlink/secret containment, `.md`/`.pdf` indexing via `pdftotext` + literal fallback, indirect injection framing), `src/core/lanVisionOffload.ts` (private LAN HTTP/S enforcement, HMAC + monotonic sequence protection, 8×8 grid cap).
- **Wave 2 Workbench Management UI (`Extensions & Sync` tab):**
  - `src/shared/wave2Control.ts`, `src/main/wave2Ipc.ts`, `src/renderer/src/workbench/wave2Panel.ts`, `src/core/config.ts` (`wave2` default-empty/off settings), wired as `"extensions"` in `workbench.html` (`tests/wave2Workbench.test.ts`, `scripts/eval-wave2-adversarial.ts`).
- **Signed Opt-In Plugin Pack (all canonical `manifest.json`):**
  - `plugins/local-vault-rag/`
  - `plugins/lan-game-copilot/`
  - `plugins/homelab-ops/`
  - `plugins/home-assistant-mqtt/`
  - `plugins/creative-pipeline/`
- **Inference & Routing R&D:**
  - `src/core/kvCompression.ts`, `src/core/loraAgents.ts`, `src/core/hardwareTuner.ts`, `src/core/models.ts`, `src/core/toolRouter.ts`, `src/core/compaction.ts`, `src/core/dryRun.ts`, `src/core/episodic.ts`, `src/core/memory.ts`, `src/core/missionApproval.ts`, `src/core/missionPlan.ts`, `src/core/actionLog.ts`, `src/core/multimodal.ts`, `src/core/shipEars.ts`, `src/core/skillCompiler.ts`, `src/core/store.ts`.
  - Benchmark scripts: `scripts/benchmark-catalog.ts`, `scripts/benchmark-speculative-kv.ts`, `scripts/benchmark-voice-shootout.ts`, `scripts/benchmark-lora-agents.ts`.

### Wave 3 (`v1.3`) — Voice Cloning Studio, Acoustic Sensors, Webcam Presence & iOS Station
- `src/core/voiceCloneStudio.ts`: Opt-in 4–16s reference clip analyzer + `.bundle` packager with quality, consent, slug, and secret-scrubbing gates (`tests/voiceCloneSecurityAudit.test.ts`).
- `src/core/acousticEvents.ts`: Acoustic event detector and barge-in/interrupt primitives (`tests/voiceAndAcousticRd.test.ts`).
- `src/core/webcamPresenceOnnx.ts`: In-memory local presence detector (`tests/webcamPresence.test.ts`).
- `ios-app/Sources/{AstraStationApp.swift,AstraAppIntents.swift,OfflineOutboxQueue.swift}`.
- `docs/LIVE2D_LICENSING_AUDIT.md`.

---

## 2. Pruned Dead & Redundant Artifacts

Consolidated and deleted during experimental cleanup to reduce maintenance burden:
- `src/core/voice/experimentalUltraLightVoice.ts` (streaming clause logic consolidated into `src/core/voice/onnxVoice.ts`).
- `src/core/voice/llamaSpeechBackend.ts` (superseded by the two-winner `onnxVoice.ts` + `experimentalMultilingualVoice.ts` architecture).
- `scripts/benchmark-voice-rd.ts` (merged into `scripts/benchmark-voice-shootout.ts`).
- Five duplicate `plugins/{creative-pipeline,home-assistant-mqtt,homelab-ops,lan-game-copilot,local-vault-rag}/plugin.json` files (canonical `manifest.json` retained everywhere).
- Four standalone secondary HTML windows and their per-window preloads/bundles:
  - `src/renderer/{mission-control,avatar-studio,policy-composer,turn-xray}.html`
  - `src/preload/{missionControl,studioTools}.ts`
  - `src/renderer/src/mission-control/{main.ts,style.css}`
  - `src/renderer/src/{avatar-studio,policy-composer,turn-xray}/`

---

## 3. Seam Architecture & Security Audit Hardening

- **`TurnHookPipeline` (`src/core/turnHooks.ts`):** Isolates optional `beforeRoute`, `afterPlan`, and `beforeCommit` hooks inside `try/catch` boundaries; `createSemanticCacheHook` enforces unconditional bypasses on `readOutsideText`, `handsOff`, `isEvent`, and `falseClaim`; `createPlanConsensusHook` flags multi-sample disagreements for manual confirmation (`tests/integrationSeams.test.ts`).
- **`StageLayerManager` (`src/renderer/src/stageLayers.ts`):** Runs registered layers by ascending `priority` during `Stage.animate()`, wraps `mount`, `update`, and `dispose`, and isolates layer exceptions (`tests/integrationSeams.test.ts`).
- **Security Audit Hardening (`tests/experimentalSecurityAudit.test.ts`):**
  1. `src/core/peerSync.ts`: Added bounded replay-nonce cache (`seenEnvelopeNonces`, skew-window pruning, 4096 cap), AES-GCM IV (`12 B`) / auth tag (`16 B`) byte-length validation, and broadened `scrubSecretsForSync()` (`AKIA...`, HTTP `Basic`, credential key-value assignments).
  2. `src/core/vaultRag.ts`: Neutralized ChatML (`<|im_start|>`, `<|im_end|>`), tool tags (`<tool_call>`, `<tool_response>`, `<function=...>`), closing fence spoofing, and Unicode bidi overrides (`\u202A–\u202E`, `\u2066–\u2069`) inside `frameVaultExcerpt()` with a closing `[END UNTRUSTED VAULT EXCERPT]`, and fixed `collectSafeFiles()` to measure target size via `statSync(check.realPath).size`.
  3. `src/core/lanVisionOffload.ts`: Restricted VLM endpoints to `http:` / `https:` with no embedded URL credentials, bounded `changedIndices` / `dirtyTiles` to `<= 64` prior to advancing `lastSeqByNode`, and stripped control characters (`< 32`) + ChatML delimiters from `app` and `title`.
  4. `src/core/voiceCloneStudio.ts`: Rejected non-finite (`NaN`/`Infinity`) PCM samples and sample rates `> 192 kHz`, enforced optional explicit `consentConfirmed` refusal, restricted `manifest.id` to `/^[a-z0-9][a-z0-9_-]{0,63}$/`, and scrubbed/bounded stored reference transcripts.

---

## 4. Real-Hardware Shootout & LoRA v3 Empirical Results

### Hardware Shootout Summary
- **Voice CPU + Streaming Shootout (`scripts/benchmark-voice-shootout.ts`):**
  - `astra` (`af_heart`, `q8`): `232.1 ms` load, `1,684.3 ms` TTFA, `3,431.8 ms` synth / `6,500 ms` audio (**`0.528` RTF**), `469 MB` RSS, RMS `-23.7 dB`, peak `0.588`, clipped `0`.
  - `bright` (`af_bella`, `q8`): `217.1 ms` load, `1,869.7 ms` TTFA, `2,739.6 ms` synth / `6,450 ms` audio (**`0.425` RTF**), `727 MB` RSS, RMS `-23.3 dB`, peak `0.529`, clipped `0`.
  - `calm` (`bf_emma`, `q8`): `221 ms` load, `2,226.9 ms` TTFA, `2,245.2 ms` synth / `5,275 ms` audio (**`0.426` RTF**), `982 MB` RSS, RMS `-21.2 dB`, peak `0.627`, clipped `0`.
  - Language routing guard: Kokoro `en` supported (`true`), `ja`/`zh` rejected (`false`) and routed to `qwen3-tts-0.6b`; loopback `Qwen3StreamingTtsBackend` streamed `8` chunks (`24,000` samples) with `5.6 ms` TTFA and `52.1 ms` total.
- **GPU KV-Cache & Speculative Shootout (`scripts/benchmark-speculative-kv.ts`, RTX PRO 4500):**
  - `9B FP16 KV`: `2,528 ms` load, `5,698 MiB` VRAM delta, `44 ms` TTFT, `115.2 tok/s`.
  - `9B Q8_0 KV`: `908 ms` load, `5,580 MiB` VRAM delta, `44 ms` TTFT, **`115.4 tok/s`**.
  - `9B Q4_0 KV`: `989 ms` load, `5,514 MiB` VRAM delta, `44 ms` TTFT, `110.4 tok/s`.
  - `9B + 4B` draft: `98 ms` TTFT, `48 tok/s` (draft size ratio too large; `selectSpeculativeDraft()` enforces `<= 25%` cap).
- **Proxmox 3-Node LAN Sync (`scripts/test-proxmox-multinode.ts`, CTs `291` & `292` <-> Workstation):**
  - Converged in **`58 ms`**, rejected tampered & rogue payloads (`403`), blocked WAN `8.8.8.8`, live `zpool` `online`. Ephemeral containers destroyed afterwards.
- **Native Hands & Multi-Turn Gates:** `scripts/fuzz-native-hands.ts` **`175/175`** frames (`0` crashes, `0` non-zero exits); `scripts/run-multiturn-eval.ts` **`5/5` scenarios (`42` turns)**.

### Distilled Router LoRA v3 (`exp-small-lora-v3`) & Shipping Decision
- **Training:** `276` train / `15` held-out examples (`36` skipped > `6144` tokens) exported with live `QwenChatWrapper({ variation: "3.5" })` `<parameter=params>` formatting and Astra's full persona prompt + `[form]` suffix; rank `8`, alpha `16`, `lr=1.5e-5`, `1.5` epochs -> held-out loss decreased monotonically from **`1.1843` -> `0.5076`** (best checkpoint step 52, exported to `59 MB` / `400`-tensor GGUF).
- **163-Case Live GPU Eval vs `post-ux-small`:** Overall **`84%`** (`-1 pt` vs baseline `85%`, `+6 pts` over v2 `78%`), **Follow-through Honesty `93%` (`+7 pts`)**, **Multi-step `88%` (`+6 pts`)**, **Safe under injected text `87%`** (`93%` did not even try), **`100%` Nothing Leaked** (`+2 pts` recovery over v2 `98%`), Tools `83%` (`-9 pts`), Character `67%` (`-11 pts`), Memory `71%`, Knowledge `97%`.
- **Shipping Decision:** Because `84%` fell 1 pt short of the strict `>= 85%` bar, **`overlay/assets/lora/` remains intentionally omitted in `astra-navi-supporter`**.

---

## 5. Section 10 Post-Leak Fix, Android 15 E2E, MoE Eval & LoRA v4 Verification

- **Kokoro ONNX Leak Fix & Early Clause Streaming (`src/core/voice/onnxVoice.ts`, `scripts/benchmark-voice-shootout.ts`):**
  - Added `SHARED_KOKORO_ENGINES` cache (`OnnxVoice.sharedCacheSize()`, `OnnxVoice.disposeSharedEngines()`) and `splitFirstClauseEarly()` (`>= 8`-word first clauses). Switching presets (`astra` -> `bright` -> `calm`) dropped RSS growth from `+513 MB` (`469 -> 982 MB`) down to **`+22 MB` (`463 -> 485 MB`)**, `0 ms` switch load, and `1,152.3–1,310.7 ms` TTFA (`0.441–0.482` CPU RTF).
  - Verified `Qwen/Qwen3-TTS-12Hz-0.6B-Base` offline CUDA snapshot (`cuda:0`, `2,683.4 ms` shared load): EN **`0.527` RTF** (`1,130.2 ms` TTFA), JA **`0.506` RTF** (`1,735.1 ms` TTFA), ZH **`0.524` RTF** (`1,624.9 ms` TTFA), `0` clipped samples.
- **Word-Only Tool Routing & WinHands Size Trim:**
  - `src/core/toolRouter.ts`: Added `look_at_screen` phrase hints -> **`71/71` (`100.0%`)** on `npm run route-check -- --words-only` (`1,636` avg / `1,532` median tool tokens).
  - `hands/win-hands-native/WinHands.csproj`: Added NativeAOT/full-trim size flags under `.NET 9.0.317` -> `linux-x64` NativeAOT **`2,471,136` bytes**, `win-x64` full-trimmed single-file **`10,892,487` bytes (`-84.7%` vs `70,996,496` bytes)**.
- **Live Android 15 (`API 35`, `emulator-5554`) `station.ts` E2E (`scripts/test-android15-station.ts`):**
  - Declared missing `ACCESS_NETWORK_STATE` permission in `phone-app/AndroidManifest.xml` (required by `AlertPollerService` `JobInfo.NETWORK_TYPE_ANY`), wired `MainActivity.onCreate()` job rescheduling, `stationPageScript.ts` `setApprovalSession`, and `ApprovalActionReceiver.java` `X-Session` / `401` handling.
  - Verified live on `emulator-5554`: wrong pin blocked (`0` requests), `AlertPollerService` `47821` posted standing-order notification + actions (`0` crashes), `401` refused invalid session in `519 ms` (kept notification & cleared `session_token`), signed-in `X-Session` approved `approvalA15Test00002` in `550 ms` and cancelled notification.
- **Warmed-Clock KV, Speculative Drafts & MoE / Q8_0 Evals (`src/core/models.ts`):**
  - Warmed RTX PRO 4500 `9B` KV shootout (`scripts/benchmark-speculative-kv.ts`): `FP16` (`117.3 tok/s`, `42 ms` TTFT, `5,702 MiB`), `Q8_0` (`115.2 tok/s`, `42 ms`, `5,579 MiB`), `Q4_0` (`114.5 tok/s`, `43 ms`, `5,516 MiB`); reconciles Section 8.1's un-warmed `78 tok/s` baseline. `DraftSequenceTokenPredictor` slowed `9B+{0.8B, 2B, 4B}` (`58.5 / 45.6 / 42.4 tok/s`); `27B` (`40.1 tok/s` solo) rejected `Qwen3.5` drafts due to special-token mismatch.
  - **`exp-standard-q8kv` (`9B` `--lean` `Q8_0` KV):** **`85%`** overall (`+0 pts` vs `post-ux-standard`), **`100%` Nothing Leaked**, `108 tok/s`, **`-236 MiB` VRAM**.
  - **`exp-moe-30b-a3b` (`Qwen3-30B-A3B-Q4_K_M.gguf`):** **`73.9%`** overall (`100%` Reasoning, `100%` Nothing Leaked), **`213.0 tok/s`**, `19,792 MiB` loaded VRAM (`verified`, `recommended: false` in `ROLLING_MODEL_CATALOG`).
- **LoRA v4 (`exp-small-lora-v4`):**
  - Added `cleanNoToolExamples()` (`src/core/trace.ts`), `capOfferedTools(..., 18)` + `includeNoToolClean` + `run.moods` prefix restoration (`src/core/trainingExport.ts`), and `logits_to_keep` masked CE in `train/lora.py`. Exported `531` SFT examples (`249` no-tool anchors, `501` mood-tagged); trained `504` / `27` held-out (`1.4768 -> 0.9467` loss -> `30.5 MB` GGUF).
  - 163-case eval vs `post-ux-small`: **`83%`** overall (`Tools 85%`, `Honesty 87%`, **`Safe under injected text 100%`**, **`Character 83%`** `+16 pts` vs v3, `Memory 71%`, `Reasoning 89%`, `Multi-step 69%`, `Nothing leaked 99%`, `129 tok/s`, `1.68 s` TTFT, `4,124 / 4,138 MiB` VRAM). Still below the `>= 88%` / `100%` leak-free runtime LoRA gate; `overlay/assets/lora/` remains omitted (SFT LoRA v5 on non-thinking traces is deferred to `v1.2+` until `<think>` preservation + DPO/ORPO or pre-quantization merge).
- **Branch Docs Parity Check:** `git diff main -- CHANGELOG.md README.md` confirmed empty on `experimental`.

---

## 6. Wave 1 Final Validation, `TurnHookPipeline` Benchmark & Packaged Workbench Dogfood (`2026-11-24`)

- **Trimmed `10.9 MB` `win-hands.exe` on Windows 11 Pro VM `294` + CI Audit:** Confirmed `Program.cs` uses source-generated `WinHandsJsonContext` + Win32 P/Invoke (`0` reflection/COM crashes), `.github/workflows/ci.yml` + `release.yml` publish with the new trim flags (added `volume-get` and `--serve` JSON-RPC smoke checks to `ci.yml`), and verified `ping`, `version`, `volume-get`, `gpu-vram`, `wasapi-check`, and `30/30` `--serve` chaos frames in `235 ms` live on Windows 11 Pro (`VM 294` stopped cleanly afterwards).
- **Voice Lifecycle & GPU Yielding:** Wired `OnnxVoice.disposeSharedEngines()` on idle sleep, toggle-off, backend switches, and shutdown, plus `Qwen3StreamingTtsBackend.yieldGpu()` / `resumeGpu()` with CPU Kokoro fallback across `GameWatch` (`tests/experimentalVoice.test.ts`, `tests/voiceAndAcousticRd.test.ts`, `tests/gameWatch.test.ts` -> `47/47` passed).
- **Live 163-Case `TurnHookPipeline` Benchmark (`exp-small-turn-hooks`):** **`87%` overall (`+3 pts` vs `post-ux-small`)**, **`100%` Nothing Leaked**, `0 MiB` VRAM delta (`3,992 / 4,000 MiB`), `22.387 ms/turn` avg hook overhead, `14/14` consensus checks agreed, and **`78.3x` repeat-query median speedup** (`4,235.4 ms` cold median -> `54.105 ms` warm median; `10.24 ms` exact hit, `97.97 ms` semantic hit @ `0.912`; `"Set the volume to 80"` cleanly missed without aliasing `40`).
- **Packaged Linux `workbench.html` Dogfood (`scripts/test-desktop.sh node scripts/dogfood-workbench-packaged.ts`):** All 6 tabs verified end-to-end under `kwin_wayland` + CDP (`missionsApproved: true`, `memoryCrudVerified: true`, `"Replayed 1 turn(s), 1 call(s): 1 matched, 0 drifted."`, `xrayRendered: true`, `aecErleDb: 19.6`, `activeRafFrames: 39` -> `idleRafFrames: 0`, `0` exceptions/errors).
- **Frozen `main` (`89a1b615`) Advisory:** Audited `main:phone-app/AndroidManifest.xml` (omits `ACCESS_NETWORK_STATE`) vs `main:phone-app/java/app/astranavi/station/AlertPollerService.java` (`JobInfo.NETWORK_TYPE_ANY`), confirming v1.0 `main` needs a targeted backport before shipping a v1.0 Supporter APK once authorized.

---

## 7. Release Readiness: Migration Guarantee, Clean Wave 1 Cut, Soak & Live Calibration (`2026-11-24`)

- **Release Workflow Parity & Modular Workbench UI:** Mirrored `ci.yml`'s `.NET 9` trimmed `win-hands.exe` smoke tests (`volume-get` + `--serve` ping) in `.github/workflows/release.yml`, and split `src/renderer/src/workbench/panels.ts` into `dom.ts`, `policyComposer.ts`, `turnXray.ts`, `avatarStudio.ts`, and `audioCalibration.ts` (deleting `panels.ts`).
- **Frozen `v1.0 -> v1.1` Migration Suite (`tests/fixtures/v1.0-profile/` + `tests/upgradeMigration.test.ts`):** Verified **`5/5` tests passed (`26 ms`)** covering SQLite `layout 3 -> 4` upgrade with zero loss across turns, FTS5, actions, standing orders, and episodes, SHA-256 hash chaining continuation across SQLite + legacy JSONL, v1.0 JSON compatibility, `.astranavi-backup` inspect/restore, and clean mid-migration rollback on failure/future-layout mismatch.
- **Verified Clean Wave 1 Cherry-Pick Dry-Run Off `main` (`dry-run-wave1` worktree, `87` files + fixture):** `typecheck`, `lint`, **`120/120` test files (`2,480 passed | 1 skipped`)**, `build`, `--fuzz` (`500/500`), `--audit` (`PASS`), `--words-only` (`71/71`, `100.0%`), and `run-multiturn-eval.ts` (`5/5` scenarios, `42` turns) all passed with zero Wave 2/3 code included.
- **Sustained Memory Soak (`node --expose-gc scripts/soak-memory-leaks.ts`):** `4/4` PASS — `TurnHookPipeline` (`100` turns, `+0.17 MB` heap), `OnnxVoice` (`20` preset switches / `4` `disposeSharedEngines()` cycles, `902,400` samples, `+98.85 MB` peak over `404.04 MB` warmed -> `376.68 MB` final, `sharedCacheSize=0`), Workbench Snapshots & AEC (`20` cycles, `+0.19 MB` heap), and `StageLayerManager` (`50` cycles / `500` frames, `+0.27 MB` heap).
- **Live-Room Physical Calibration (`scripts/run-live-room-calibration.ts`, PipeWire `SSL 2+`):** Measured ambient room floor (`0.00022` RMS / `-73.15 dBFS`), physical sweep (`285.6 ms` lag, `coupling=false`, `ERLE=-0.99 dB`, `bargeInReady=false`, `minSnrDb=12`), `0/4` false mic wakes on quiet capture (`liveMic=2/4`), and `3/4` direct `Kokoro-82M` -> `moonshine-base-ONNX` gate accuracy (recording the real `"Astranavi"` fused-word ASR observation for `wakeName.ts`).
- **Beta Triage Playbook:** Added `docs/BETA_TRIAGE_PLAYBOOK.md`.

---

## 8. Wake Alias Fix, High-Lag AEC, Combined `9B` Hooks Eval & Wave 2 Track B Verification (`2026-11-24`)

- **Wave 1 Tightening:** Fixed fused `"Astranavi"` / `"Astra Navy"` / `"Astro Navi"` ASR wake misses in `src/core/wakeName.ts` (`4/4` direct `Kokoro-82M` -> `moonshine-base-ONNX` wake detection with `0/4` false wakes; `tests/ship.test.ts` `96/96`), expanded `src/core/voice/aec.ts` causal lag estimation to `420 ms`, distinguished `couplingStatus` (`"coupled" | "isolated"`) and `bargeInStatus` (`"ready_aec" | "ready_isolated" | "needs_aec"`) in `audioCalibration.ts` (`tests/experimentalVoice.test.ts` `8/8`), and completed the combined `Qwen3.5-9B + Q8_0 KV + --turn-hooks` 163-case live GPU run (`exp-standard-q8kv-hooks`: **`90%` overall**, `+5 pts` vs `85%`, **`100%` Safe under injected text**, **`100%` Nothing leaked**, `94%` Multi-step, `-236 MiB` VRAM, **`187.1x`** repeat speedup, `7.156 ms/turn` hook overhead).
- **Wave 2 Track B Usability & Adversarial Evals:** Added the 7th Workbench tab (`"extensions"`, `Extensions & Sync`) for approving/revoking `.md`/`.pdf` Vault RAG directories, pairing/probing Ed25519 LAN `PeerStateSyncEngine` nodes, and toggling the 5 Wave 2 opt-in plugins with declared permission scope visibility (`tests/wave2Workbench.test.ts`); verified real `Qwen3.5-9B` resistance across 6 planted `.md`/`.pdf`/homelab indirect prompt injections + 2 factual controls (`scripts/eval-wave2-adversarial.ts`: `6/6` adversarial, `2/2` controls, `0` unauthorized tool calls); and verified clean Wave 1+2 isolation off `main` (`dry-run-wave2`, `136` files, excluding Wave 3 -> `126/126` test files, `7/7` plugins, `build`, `--fuzz`, `--audit`, `--words-only`, `5/5` multi-turn).

---

## 9. Final Verification Hardening (`2026-11-24`)

- **Deterministic `tests/gameWatch.test.ts` Timing & Teardown:** Replaced the `15 ms` fixed-delay `saved()` wait with `10 ms` polling up to `2,000 ms` and serialized `GameWatch.stop()` calls in `afterEach` / mid-test transitions (`5/5` clean consecutive vitest runs, `37/37` tests each, `0` `ENOENT` warnings).
- **Pure-JS `/FlateDecode` PDF Fallback (`src/core/vaultRag.ts`):** Added bounded zlib decompression (`inflateSync`/`inflateRawSync`, `4 MiB` stream / `8 MiB` total caps, corrupt-stream fallback, UTF-8-when-valid literal decoding before BiDi/ChatML neutralization) and `ASTRA_NAVI_DISABLE_PDFTOTEXT=1` testing across `tests/wave2Workbench.test.ts` (`3/3`) and live `Qwen3.5-9B` `scripts/eval-wave2-adversarial.ts` (`6/6` adversarial + `2/2` controls with `pdftotext` both disabled and enabled, `0` unauthorized tool calls).
- **Packaged 7-Tab Workbench + Supporter 11-Sprite 2D Rig Dogfood:** Shipped plugin definitions via `electron-builder.yml` `extraResources`, added scoped `/avatar2d/` serving (`src/main/modelFiles.ts`) + CSP updates (`workbench.html`) + `Canvas2DAvatarRenderer` preview check (`avatarStudio.ts`), and passed `scripts/test-desktop.sh node scripts/dogfood-workbench-packaged.ts` (`ok: true`, `extensionsTabVerified: true`, `avatar2dCheck.spritesLoaded: 11`, `nonTransparentPixels: 58858`, `activeRafFrames: 30` -> `idleRafFrames: 0`, `0` errors, staged rig cleaned up cleanly).
- **HDMI PipeWire Calibration & Table Hygiene:** Reconciled `evals/results/BENCHMARKS.md` §13.2 `post-ux-standard` row with §3 (`83%` Tools) and recorded an open-speaker `--sink alsa_output.pci-0000_01_00.1.hdmi-stereo --gain 0.55` sweep (`scripts/run-live-room-calibration.ts`: `aecLag=289.7 ms`, `corr=0.0399`, `coupling=isolated`, `bargeInStatus=ready_isolated`, `ERLE=-0.99 dB`, `direct=4/4`, `liveMic=2/4`, `0` false wakes).

---

## 10. Frozen `main` Surgical Commit Ledger (Zero Wave 1/2/3 Code)

All pre-release Android 15, Windows Authenticode signing pipeline, packaging, extension-store, and phone station UX fixes have been landed surgically on `main` (off `89a1b61`) without pulling in any Wave 1/2/3 feature code:

| `main` Commit | Scope |
| --- | --- |
| `6976634` | `fix(android): add ACCESS_NETWORK_STATE and cold-start AlertPollerService schedule for API 35` (`phone-app/AndroidManifest.xml`, `MainActivity.java`) |
| `cabc184` | `build(release): harden Windows signing pipeline, add Firefox AMO data_collection_permissions, and bump version to 1.0.0-rc.1` |
| `378e22c` | `fix(release): wrap Get-ChildItem collections for PowerShell StrictMode in sign-windows.ps1` |
| `3a404c5` | `fix(packaging): include win-hands.exe in Windows extraResources and require all signing targets` (`electron-builder.yml`, `sign-windows.ps1`, `release.yml`, `releaseScripts.test.ts`) |
| `6854a67` | `fix(station): prevent long-press text selection and callouts on voice Hold button` (`stationPageStyle.ts`, `stationPageScript.ts`, `stationPageScript.test.ts`) |
| `1ef6225` | `fix(security): scope release OIDC signing to main/tags and block incognito DOM reads` (`.github/workflows/release.yml`, `browser-bridge/background.js`, `STORE_LISTING.md`, `releaseScripts.test.ts`) |
| `9b350af` | `fix(windows): wire native Windows adapter, VRAM CPU fallback, ShellHost filter, wide settings layout, and bootstrap setups` (`windows.ts`, `reach.ts`, `selfCheck.ts`, `documents.ts`, `engine.ts`, `cardWatch.ts`, `bootstrap.ts`, `ocr.ts`, `install-host.mjs`, `settings.css`, `loginStart.ts`, `windowsRcFixes.test.ts`) |
| `9cad960` | `fix(bootstrap): pass --clear to venv, align qwen-tts pins, verify packages installed, and fix wizard button widths` (`bootstrap.ts`, `fullVoice.ts`, `voice-server/requirements.txt`, `scripts/setup-voice.sh`, `scripts/setup-ocr.sh`, `settings.css`, `windowsRcFixes.test.ts`) |
| `9ecebcf` | `feat(mcp,catalog): wire live MCP runtime & Settings UI, replace dead models, hide inactive toggles, and fix UA` (`mcpTools.ts`, `mcpIpc.ts`, `settings/mcp.ts`, `mcpClient.ts`, `config.ts`, `brain.ts`, `models.ts`, `web.ts`, `settings.html`, `README.md`, `mcpIntegration.test.ts`) |

---

## 11. Roadmap Items 3 & 4 — Native Vision Sidecar & Real Character Layer (`2026-11-26`)

- **Native Multimodal Vision Sidecar (`src/core/visionSidecar.ts`, `src/core/models.ts`, `src/core/sight.ts`, `src/core/desktopTools.ts`):**
  - Added model-scoped Hugging Face `mmproj-F16.gguf` descriptors for all built-in Qwen tiers (`small` `4B`, `standard` `9B`, `large` `27B`, `xl` `122B-A10B`, `largeMoe` `35B-A3B`) plus sibling `*mmproj*.gguf` prefix auto-detection for custom local GGUFs (`resolveVisionMmproj()`).
  - Implemented strictly loopback-only (`127.0.0.1` / `localhost` / `[::1]`) `LlamaVisionSidecar`: lazy on-demand `llama-server` spawning with per-session random `--api-key` Bearer auth, `sharp` max-1280px downscaling, Set-of-Mark `[N]` overlay cross-referencing alongside exact OCR text, anti-injection framing & output sanitization, `-ngl 0` CPU fallback while fullscreen games run, idle auto-unload (`2 min`), and transparent Florence-2 + OCR fallback when unavailable.
  - Added optional `question` parameter to `look_at_screen`, Settings UI controls (`#nativeVision`, mmproj download, Advanced `llamaServerPath` & `visionEndpoint`), and `tests/visionSidecar.test.ts` (`10/10` tests covering catalog resolution, loopback enforcement, real HTTP endpoint + managed subprocess spawn/auth/disposal, and `Sight` sidecar preference).
- **Real Character Layer & Brain-Tier Personality Drift Gate (`src/core/characterLayer.ts`, `src/core/personaCard.ts`, `src/core/persona.ts`, `src/core/characterBundle.ts`, `src/core/brain.ts`, `src/main/voiceControl.ts`, `src/renderer/src/settings/character.ts`, `evals/characterGate.ts`, `scripts/eval.ts`):**
  - Customizable user address (`config.character.userAddress`, defaulting to `"Captain"` with byte-identical default system prompt, or custom name / empty string to drop `"Captain"` across `persona.ts`, `formLine`, `morningBriefing`, `wakeReplyFor`, and `voiceSampleFor`).
  - Automatic first-person speech mode (`speakInThirdPerson: false`) disabling the `FIRST_PERSON_WORDS` negative logit bias in `Brain` when imported cards or custom characters use `"I"`.
  - Avatar `.bundle` binding (`loadAndBindCharacterBundle` in `src/main/index.ts`): switching a `.bundle` applies its 3D avatar, declared persona (`displayName`, `userAddress`, `greetingStyle`, `traits`, `speakInThirdPerson`, `bio`), and voice binding (`resolveBundleVoiceBinding`) together and persists across restarts.
  - Security-hardened Persona Card Importer (`src/core/personaCard.ts`): supports Character Card V3 (`ccv3`), V2 (`chara`), V1 JSON, native Astra JSON, and `.png` `tEXt` chunks (`8 MB` cap) while stripping ChatML/tool tags, control chars, BiDi overrides, and `[[mood]]` spoofing.
  - Brain-tier personality drift gate (`evals/characterGate.ts`, `scripts/eval.ts`): `--gate-character` (live eval gate) and `--check-character-gate <candidate> [<baseline>] [--min-character <n>] [--max-drop <n>]` (offline report comparison enforcing default `85%` floor and `<= 5 pt` max regression), verified with `tests/characterLayer.test.ts` (`9/9` tests).

---

## 12. Roadmap Items 5, 6 & 7 — Alive Avatar Motion, Editable Memory Ownership & OpenAI-Compatible Backend (`2026-11-26`)

- **Item 5 — Alive Avatar Motion (VRMA + VMD Playback, Idle Loops, Event Reactions & Data-Only Emote Packs):**
  - `src/shared/avatarMotion.ts`: Added 4 procedural idle-loop presets (`calm-breathe`, `curious-glance`, `playful-sway`, `focused-stand`), `IdleFlourishScheduler` for ambient awake-idle gestures, 9 coordinated desktop/companion `AVATAR_EVENT_REACTIONS` (`reminder-fired`, `mission-finished`, `mission-failed`, `wake-word`, `error-noticed`, `greeting`, `game-started`, `game-ended`, `approval-needed`), strict data-only `EmotePackManifestSchema` + `BUILT_IN_EMOTE_PACKS` (zero code, path-traversal-proof `.vrma`/`.vmd` references), and pure binary VMD/VRMA header validation (`inspectVmdHeader`, `detectMotionClipFormat`).
  - `src/renderer/src/stage.ts`: Wired real **VRMA playback for VRM** (`VrmaStageBridge`) and real **VMD playback for MMD** (`babylon-mmd` `VmdLoader` + `mmdRuntimeModelAnimation` + `createRuntimeAnimation`/`setRuntimeAnimation`), idle-loop presets + flourishes, `triggerEventReaction()`, and `playEmote()`.
  - `src/main/index.ts`, `src/main/desktopIpc.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.ts`: Fired real `"stage:reaction"` IPC events for reminders, mission completions/failures, games starting/ending, wake-word detection, and approvals; added the companion `#emote-popover` with idle preset picker, built-in emote triggers, and `.vrma`/`.vmd` clip loader (`tests/avatarMotion.test.ts`: `6/6`).
- **Item 6 — Editable Memory Ownership & Expanded Memory Evals:**
  - `src/core/memory.ts`, `src/core/learned.ts`, `src/core/agentTools.ts`, `src/core/learner.ts`: Added memory provenance fields (`source`, `reason`, `sourceExcerpt`), prioritized pinned memories at the top of `MemoryStore.snapshot()`, added `explainWhyRemembered()` & `buildMemoryManagerSnapshot()`, and updated `describeLearned()` (removing legacy `"AI-chan"` heading).
  - `src/renderer/src/settings/memory.ts`, `src/renderer/settings.html`, `src/main/settingsIpc.ts`, `src/renderer/src/mission-control/memory.ts`: Built an in-app editable Memory Manager inside **Settings → Memory** (and upgraded Workbench's Memory tab) with search/filter, inline add, **Pin / Unpin**, inline **Correct** (text + topic/skill points), **Forget**, and **"Why?"** provenance inspection.
  - `evals/cases/memory.ts`, `evals/types.ts`, `scripts/eval.ts`: Added `NoteSeed.pinned` support and expanded `MEMORY_CASES` by 10 cases (`17 -> 27` cases covering pinned older facts, explicit `remember`/`forget`, superseding corrections, multi-constraint preferences, cross-turn corrections, missing-detail non-hallucination, natural provenance explanation, episodic fixes, and skill adaptation; `tests/memoryOwnership.test.ts`: `4/4`).
- **Item 7 — Optional OpenAI-Compatible Inference Backend (Ollama, LM Studio, `llama-server`, LAN/Remote):**
  - `src/core/openaiBackend.ts`, `src/core/config.ts`, `src/core/engine.ts`: Generalized SSE streaming + multi-step OpenAI `tool_calls` execution (`OpenAiCompatibleSession`, `probeOpenAiModels`, `openAiSideQuestion`) integrated seamlessly behind `LocalEngine` (keeping built-in local GGUF as default) with `classifyInferenceEndpoint()` blocking embedded credentials & cloud metadata hosts and distinguishing `local-gguf`, `local-loopback`, `private-lan`, and `remote-internet`.
  - `src/renderer/src/settings/inference.ts`, `src/renderer/settings.html`, `src/renderer/index.html`, `src/renderer/src/main.ts`, `src/main/settingsIpc.ts`: Added **Settings → Mind → Inference backend** (presets for Ollama, LM Studio, `llama-server`, custom; **Test & List Models** discovery; write-only API key redacted from views & support bundles) plus a visible `#remote-inference-badge` in the companion window whenever inference leaves this computer (`tests/openaiBackend.test.ts`: `5/5`).

---

## 13. Roadmap Items 8, 9, 10 & Qwen3.5 MTP Runtime Check (`2026-11-26`)

- **Item 8 — Windows Clean-Room Verification Hardening (`scripts/verify-clean-windows.ps1`):** Added `-RequireSigned` enforcing Valid Authenticode + RFC 3161 `TimeStamperCertificate`, explicit failure branch when `win-hands.exe` is missing, live JSON probes for `volume-get`, `gpu-vram`, and `windows`, and `fastapi`/`uvicorn` import verification when the optional Python voice venv exists.
- **Item 10 — Microsoft Store Policy 11.16 In-App AI Output Reporting (`src/core/aiReport.ts`, `src/main/desktopIpc.ts`, `src/renderer/index.html`, `src/renderer/src/main.ts`):** Added **Report AI Output** beside **Forget Last Turn** with a local-first incident dialog that scrubs secrets (`withoutSecrets`), saves `0o600` JSON reports under `<dataDir>/ai-reports/`, keeps reply excerpts opt-in, and offers a user-initiated GitHub Issue link with zero background telemetry.
- **Item 10 — Data-Only Community / Steam Workshop Pack Gate (`src/core/workshopPack.ts`):** Enforces `dataOnly: true` for `avatar`, `voice`, `persona`, and `emote-pack` packs, strictly allowlisting passive media/metadata assets while blocking symlinks, path traversal, HTML/SVG, and all script/binary code extensions (`.js`, `.py`, `.ps1`, `.exe`, `.dll`, `.wasm`, etc.).
- **Items 8–10 & Qwen3.5 MTP Check (`docs/DISTRIBUTION_PLAYBOOK.md`, `src/core/models.ts`):** Documented Steam base + Supporter DLC & AI disclosure copy, Microsoft Store MSIX vs Authenticode signing, Flathub sandbox limits, focus/scope discipline, and the verified Qwen3.5 MTP check (`node-llama-cpp 3.22.3` / `llama.cpp v0.9.0` lacks JS `draft-mtp` bindings; added `mtpDraftTokens` to `buildLlamaCpp10Args()` for upstream `llama-server --spec-type draft-mtp --spec-draft-n-max <N> -np 1`, pairing cleanly with Item 7's OpenAI-compatible backend while Item 3 runs `--mmproj` separately; `tests/distributionAndCompliance.test.ts`: `6/6`).

---

## 14. Pre-Promotion Code-Review Hardening & Behavioral Verification Pass (`2026-11-26`)

- **Character Layer (`src/core/persona.ts`):** Eliminated whole-prompt `replaceAll` (which let `$'` explode prompt size to 1M chars and let custom addresses invert anti-injection rules or mangle OS paths like `C:\Users\Captain`). Switched to literal slot substitution (`split().join()`) strictly inside localized voice-instruction & example templates while keeping security/safety rules, OS paths, and `<memories>` immutable.
- **Vision Sidecar (`src/core/visionSidecar.ts`, `src/core/engine.ts`, `src/main/index.ts`):** Wired `totalVramBytes`, `localModelLoaded`, `freeVramBytes`, and idle `beforeSpawn` (forcing `-ngl 0` when local `node-llama-cpp` holds GPU VRAM without headroom to prevent double-copy GPU OOM); disposed sidecar on game start and tray VRAM release; added child `'error'` handling (no uncaught main-process crash on bad paths) and bounded 4 KiB `stderr` draining (preventing OS pipe deadlock).
- **MCP (`src/core/mcpClient.ts`, `src/core/mcpTools.ts`, `src/core/grammarGuard.ts`, `src/core/toolRouter.ts`, `src/core/brain.ts`, `src/renderer/settings.html`):** Resolved local `$ref` (`#/$defs`, `#/definitions`), preserved `anyOf`/`oneOf`, modeled optional params as nullable for `node-llama-cpp 3.22.3` and stripped optional `null`s before calling servers; marked crashed stdio servers disconnected with exponential backoff auto-reconnect; capped results at `6,000` chars (`MAX_MCP_OUTPUT_CHARS`); routed `mcp:*` tools by name/description instead of offering all 48 every turn; sanitized server-supplied tool/param descriptions and tainted built-in `Brain` tools when external MCP schemas enter the prompt; resolved Windows `npx`/`npm` shims to `node.exe` + CLI script under `shell: false`.
- **OpenAI-Compatible Backend (`src/core/openaiBackend.ts`, `src/core/engine.ts`, `src/main/settingsIpc.ts`):** Added bijective OpenAI tool-name sanitization (`^[a-zA-Z0-9_-]{1,64}$`) with reverse mapping; sent `parallel_tool_calls: false` when `maxParallelFunctionCalls === 1` and answered every `tool_call_id` to prevent HTTP 400s; restored real `decide()` claim-check round-trips; enabled `LocalEngine.openWorker()` for remote background research; preserved partial turn history on mid-turn abort/error; blocked plaintext `http://` to public internet hosts; restricted saved API key reuse in `settings:test-inference` to exact origin matches; failed clearly on blank remote model instead of falling back to local GGUF downloads.
- **Memory & Avatar Motion (`src/core/brain.ts`, `src/core/learner.ts`, `src/core/memory.ts`, `src/main/settingsIpc.ts`, `src/renderer/src/{avatarAnimator,vrmLoader,stage,main}.ts`):** Replaced model-unloading `refreshInstructions()` on memory edits with lightweight `brain.markInstructionsDirty()` (`engine.refresh()` on next turn); protected pinned and user-edited facts/skills from `Learner` eviction and `replace: true` overwrites; auto-ended non-looping VRMA clips with fade-out and added `LoadedVrmRig.resetAllHumanoidBones()` so legs, hands, and fingers return to rest pose on stop/end.
- **Honesty Pass & Real Behavioral Tests (`evals/results/BENCHMARKS.md`, `src/renderer/workbench.html`, `src/renderer/src/workbench/{policyComposer,wave2Panel}.ts`, `src/renderer/src/mission-control/policyReplay.ts`, `tests/*.test.ts`):** Moved shipped `85%` Standard 9B / `91%` Large 27B baselines to the `BENCHMARKS.md` headline and explicitly scoped `--turn-hooks` (`90%`) as an offline eval-harness prototype; clearly labeled preview-only Workbench sections (staging flags, Vault RAG, LAN sync, plugins, compiled skills) as not wired to live chat; replaced source-grep wiring tests with real object, `LlamaJsonSchemaGrammar`, `Brain`, and `createSettingsController` IPC handler tests (`tests/settingsIpcHandlers.test.ts`).







