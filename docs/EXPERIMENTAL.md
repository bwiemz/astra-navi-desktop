# Astra Navi Desktop — Experimental Branch Roadmap & Inventory

> **Branch Policy:** All items listed here live exclusively on the `experimental` branch (`main` remains frozen at `89a1b61541851720ee4edb3aa0264180ed41ced7` in `astra-navi-desktop` and `6fafaef58ad389afc47f082ae65c2448ba0979cc` in `astra-navi-supporter` for v1.0 release stability). `CHANGELOG.md` intentionally mirrors `main`.

---

## 1. Promotion Waves

Every experimental addition relative to `main` is assigned to an explicit post-v1 promotion wave:

### Wave 1 (`v1.1`) — Consolidated Workbench, Seams, 2-Tier Voice & Evaluation Upgrades
- **Unified Tabbed Workbench Window (`workbench.html`):**
  - Replaced four separate secondary Chromium windows (`mission-control.html`, `avatar-studio.html`, `policy-composer.html`, `turn-xray.html`) with one tabbed secondary Electron window (`src/renderer/workbench.html`) and left navigation rail (`Missions`, `Memory Graph`, `Policy Composer`, `Turn X-Ray`, `Avatar Studio`).
  - Modules: `src/shared/workbench.ts`, `src/preload/workbench.ts`, `src/main/workbenchIpc.ts`, `src/main/missionControlIpc.ts`, `src/main/studioToolsIpc.ts`, `src/shared/missionControl.ts`, `src/shared/studioTools.ts`, `src/renderer/src/workbench/{main.ts,panels.ts,style.css}`, `src/renderer/src/mission-control/{missions.ts,memory.ts,policyReplay.ts}`, `electron.vite.config.ts`, `src/main/tray.ts`, `src/main/index.ts`.
  - Animation frame pausing (`requestAnimationFrame` active only when the `Avatar Studio` tab is selected).
- **Feature-Flagged Runtime Seams (`TurnHookPipeline` & `StageLayerManager`):**
  - `src/core/turnHooks.ts` (`TurnHookPipeline`, `createSemanticCacheHook`, `createPlanConsensusHook`) mounted behind optional `EngineOptions.turnHooks` in `src/core/engine.ts` and `src/core/brain.ts` (zero-cost no-op when unset), integrating `src/core/semanticCache.ts` and `src/core/planConsensus.ts`.
  - `src/renderer/src/stageLayers.ts` (`StageLayerManager`, `createAvatarAnimatorLayer`, `createVrmaBridgeLayer`, `createStageLightingLayer`, `createCanvas2DLayer`) mounted onto `src/renderer/src/stage.ts` (`registerLayer`, `unregisterLayer`, `runStageLayers`, `dispose`), integrating `src/renderer/src/{avatarAnimator,vrmaStageBridge,stageLighting,canvas2dStage}.ts` and `src/shared/{avatar2d,gestures,spatialStage,visemes,vrma}.ts`.
- **Two-Tier Zero-Python Voice Stack:**
  - `src/core/voice/onnxVoice.ts`: Lightweight CPU-only English tier (`kokoro-82m`, `q8`/`fp32`, `splitStreamingClauses()`, `synthesizeStream()`). Built-in presets declare honest `languages: ["en"]`; Japanese/Chinese route cleanly to the streaming multilingual tier.
  - `src/core/voice/experimentalMultilingualVoice.ts`: High-quality streaming & code-switch tier (`qwen3-tts-0.6b` chunked PCM16 streaming, `Qwen3AsrMultilingualClient`, `detectCodeSwitchSpans`).
  - `src/core/voice/expressiveAudio.ts` & `src/core/voice/speechText.ts`: Acoustic F0/pause/emphasis cue extraction and prosody script parsing.
- **Qwen3.5 Template Alignment & Multi-Turn / Native Fuzz Gates:**
  - `src/core/trainingExport.ts` & `scripts/export-pairs.ts`: Byte-exact alignment with runtime `QwenChatWrapper({ variation: "3.5" })` (`<parameter=params>`, `JSON.stringify` `<tool_response>`, real `buildSystemPrompt`, `[form]` suffix).
  - `evals/multiTurnSim.ts`, `scripts/run-multiturn-eval.ts`, `scripts/fuzz-native-hands.ts`.
- **Android Companion Quick Controls:**
  - `phone-app/java/app/astranavi/station/{VoiceWidgetProvider,PushToTalkTileService,ApprovalActionReceiver,AlertPollerService,MainActivity}.java`, `phone-app/AndroidManifest.xml`, and layouts/resources (`voice_widget.xml`, `voice_widget_info.xml`, localized strings).

### Wave 2 (`v1.2`) — Hardened Opt-In Plugin Ecosystem, Multi-Node Sync & Adaptive Inference
- **Encrypted Multi-Node LAN Sync & Fleet Hardening:**
  - `src/core/peerSync.ts` (AES-256-GCM + Ed25519 LWW CRDT + replay-nonce protection + secret scrubbing), `scripts/test-proxmox-multinode.ts`.
- **Opt-In Local Vault & LAN Offload Backends:**
  - `src/core/vaultRag.ts` (approved-root symlink/secret containment, indirect injection framing), `src/core/lanVisionOffload.ts` (private LAN HTTP/S enforcement, HMAC + monotonic sequence protection, 8×8 grid cap).
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
- `src/core/voiceCloneStudio.ts`: Opt-in 4–16s reference clip analyzer + `.bundle` packager with quality, consent, slug, and secret-scrubbing gates.
- `src/core/acousticEvents.ts`: Acoustic event detector and barge-in/interrupt primitives.
- `src/core/webcamPresenceOnnx.ts`: In-memory local presence detector.
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
