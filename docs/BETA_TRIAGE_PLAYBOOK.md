# Astra Navi Beta Triage & Support Playbook (`v1.0 -> v1.1`)

Operational runbook for triaging v1.0 release issues, hotfix backports, and v1.1 beta regressions without cross-contaminating frozen `main` and active `experimental` branches.

---

## 1. Branch & Hotfix-First Discipline

| Branch | Status | Rule |
|---|---|---|
| `main` | Frozen (`v1.0` baseline: `89a1b615` desktop, `6fafaef5` supporter) | **Never** merge `experimental` into `main`. Fixes enter `main` only as minimal, single-purpose hotfix commits after sign-off, then cherry-pick forward to `experimental`. |
| `experimental` | Active R&D & Wave 1 (`v1.1`) staging | All beta features, Workbench tabs, two-tier ONNX/Qwen3 voice, and Wave 2/3 R&D land here. Wave 1 promotions cherry-pick cleanly off `main` (verified via `/tmp/dry-run-wave1`, 87 files + fixtures). |

- Keep `CHANGELOG.md` and `README.md` synchronized to `main` until a wave promotion is cut (`git diff main -- CHANGELOG.md README.md` stays empty on `experimental`).

---

## 2. Priority #0 Pre-APK Fix on Frozen `main` (Android 15 / API 35)

- **Symptom:** On Android 15 (`API 35`), scheduling `AlertPollerService` with `JobInfo.Builder.setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)` throws `SecurityException: Caller lacks android.permission.ACCESS_NETWORK_STATE`.
- **Root Cause Verified:** `main:phone-app/AndroidManifest.xml` (`2,340` bytes) omits `ACCESS_NETWORK_STATE`, while `main:phone-app/java/app/astranavi/station/AlertPollerService.java` uses `JobInfo.NETWORK_TYPE_ANY`.
- **Mandatory Fix Before Cutting Any v1.0 Supporter APK:**
  1. Declare `<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />` in `phone-app/AndroidManifest.xml`.
  2. Call `AlertPollerService.schedule(...)` during cold start in `MainActivity.onCreate()` alongside WebView sign-in rescheduling so background alerts survive app process death without requiring manual re-entry.
  3. Verify on API 35 emulator (`scripts/test-android15-station.ts`) before uploading APK artifacts.

---

## 3. Windows SmartScreen / Defender & Trimmed `win-hands.exe` Triage

- **Unsigned / Fresh-Certificate SmartScreen Prompts:**
  - Confirm SHA-256 checksum matches the GitHub Release asset (`release.yml`) before advising override.
  - Check Windows Defender Quarantine history (`Protection history`) if native helper spawn fails with `ENOENT` or `EACCES`.
- **Trimmed `.NET 9` Single-File `win-hands.exe` (`10.9 MB`):**
  - If UI Automation / JSON serialization fails on a user host, run standalone CLI checks in PowerShell:
    ```powershell
    '{}' | .\win-hands.exe ping
    '{}' | .\win-hands.exe volume-get
    '{"id":"1","verb":"ping"}' | .\win-hands.exe --serve
    ```
  - Verify `.github/workflows/ci.yml` and `.github/workflows/release.yml` both publish with identical NativeAOT / trim flags and pass both smoke checks.

---

## 4. Transparent Overlay, DirectX / Vulkan & Game-Mode GPU Triage

- **Symptom:** Flickering transparent window, black backdrop under NVIDIA/AMD overlays, DirectX/Vulkan fullscreen borderless stutter, or compositor conflicts (Steam Overlay, OBS, wallpaper engines).
- **Immediate Triage Ladder:**
  1. **Switch Window Mode (`windowMode: "solid-docked"`):** Disables OS compositor alpha transparency and renders Astra Navi inside an opaque docked frame (also reversible live via Avatar Studio or Settings).
  2. **Enable Low-Power Stage (`lowPowerStage: true`):** Throttles 3D Babylon rendering overhead when GPU contention or battery pressure is high.
  3. **GameWatch GPU Yielding:** Verify `yieldToGames` is enabled so local `Qwen3StreamingTtsBackend` unloads cleanly (`POST /v1/tts/unload`) and falls back to CPU `OnnxVoice` (`Kokoro-82M` `q8`) while fullscreen games are active.
  4. **Automatic Safe Mode (`StartupGuard`, `src/core/safeMode.ts`):** After **`>= 2` consecutive unrecovered crashes** prior to reaching healthy uptime (`crashThreshold = 2`), `startup-state.json` activates Safe Mode automatically, pausing optional background watchers (screen watch, hands, PC audio, notices, station) so the user can open Settings / Avatar Studio and recover cleanly.

---

## 5. User-Supplied `.vrm` / `.pmx` Model Framing & Load Failures

- **Symptom:** Third-party `.vrm` or `.pmx` avatar spawns off-center, clipped, oversized, or with washed-out rim lighting.
- **Triage & Recovery:**
  1. Open **Workbench -> Avatar Studio** (or inspect `config.json` `avatarFraming[modelHash]`): tune `scale` (`0.45–2.2`), `offsetX` (`-0.6–0.6`), `offsetY` (`-0.6–0.6`), `rimLight` (`0.4–1.8`), and `outlineThickness` (`0–2.5`).
  2. If a corrupt model binary crashes WebGL/Babylon twice in a row, `StartupGuard` pauses optional hooks on boot `3`; reset `characterBundle` or switch back to the 2D Canvas fallback (`Canvas2DAvatarRenderer`) / default rig.
  3. On `vrm`/`pmx` load errors with no repro locally, collect a redacted support bundle (`schemaVersion: 1`) plus the exact model format and shader logs.

---

## 6. Support Bundle Collection & Deterministic `--replay` Incident Reproduction

- **Step 1 — Collect Redacted Diagnostics:** Generate a `RedactedSupportBundle` via `buildRedactedSupportBundle()` (`src/core/supportBundle.ts`), which strips API tokens, local home paths, and forbidden raw conversation fields (`conversations`, `conversationHistory`, etc.) while preserving `app`, `desktopSession.notice`, `hardware`, `bootstrapStatus`, `selfCheck`, `settingsSummary`, `recentErrors`, and `redactionsApplied`.
- **Step 2 — Export & Replay Problematic Agent Turns Offline:**
  - Have the user or tester export the affected trace window to a `.json.gz` replay bundle (`src/core/replay.ts` — automatically scrubs secrets and drops `withheld` turns, `0600` permissions).
  - Reproduce policy verdict drift or tool-gate regressions offline without calling an LLM:
    ```bash
    npm run eval -- --replay <bundle.json.gz>
    ```
- **Step 3 — Profile & DB Upgrade Issues (`v1.0 -> v1.1`):**
  - Confirm `her.db` `PRAGMA user_version` (`3` on `v1.0`, `4` on `v1.1` hash-chained `actions`) and verify backup integrity with `inspectProfileBackup()` (`ASTRANAVI_PROFILE_V1`, `src/core/profileBackup.ts`).
  - Failed SQLite migrations roll back cleanly inside the upgrade transaction without touching pre-existing v1.0 JSON/SQLite rows (`tests/upgradeMigration.test.ts`).
