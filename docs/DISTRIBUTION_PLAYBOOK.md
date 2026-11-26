# Astra Navi Desktop — Distribution, Store Compliance & Focus Playbook

This playbook translates roadmap items **8, 9, and 10** plus the **Qwen3.5 MTP GGUF** runtime audit into concrete release checklists for shipping Astra Navi Desktop cleanly across **Steam**, **Microsoft Store (MSIX)**, **GitHub / itch.io**, and **Linux**.

---

## 1. Steam (Primary Storefront — Base App + Supporter Edition DLC)

### Packaging & DLC Mapping
- **Base App (Free / Community):** Core local desktop companion (3D VRM/MMD stage, local GGUF brain, live MCP tool integration, editable memory, native vision sidecar, character bundles & persona cards, built-in offline voice).
- **Supporter Edition DLC (Steam DLC AppID):** Unlocks bonus cosmetic avatar rigs, 2D layered sprite overlays, extra emote packs, and supporter themes without paywalling security, MCP, memory ownership, or local inference.

### Steamworks AI-Generated Content Disclosure (Ready-to-Paste Draft)
- **Live-Generated Content:** *Yes — local, on-device open-weight language model inference (default Qwen3.5 GGUF via `llama.cpp`, or an optional user-configured OpenAI-compatible local/LAN server).*
- **Pre-Generated Content:** *No AI-generated copyrighted assets; shipped default 3D navigator model and UI assets are original/properly licensed.*
- **Guardrails Disclosure:**
  1. All local inference and memory stay on the user's own hardware by default; no cloud prompts or telemetry are sent unless the user explicitly configures an off-machine server (clearly badged in the companion window).
  2. Every mutating desktop, shell, file, browser, or MCP tool call passes through a centralized permission guard (`permissions.ts`) requiring explicit user approval.
  3. Untrusted external text (web pages, files, command output, MCP responses, notifications) taints the turn and enforces strict confirmation before side effects (`500/500` adversarial fuzz gate + `0` static audit findings).
  4. Users can report unexpected or problematic AI output directly in-app (**Report AI Output**).

### Steam Workshop Policy (Data-Only Launch — Scaffolded, Pending Workshop Integration)
- **Launch strictly with Data-Only Packs** (`avatar`, `voice`, `persona`, `emote-pack`), validated by the scaffolded `src/core/workshopPack.ts` (`auditWorkshopPackDirectory()`) once Steam Workshop loading is wired into runtime (not yet connected while Workshop is not live):
  - Requires `manifest.json` with `schemaVersion: 1` and `dataOnly: true`.
  - Allowlists only passive media/metadata assets (`.json`, `.vrm`, `.glb`, `.pmx`, `.pmd`, `.vrma`, `.vmd`, image & audio formats, `.txt`/`.md`).
  - Explicitly blocks symlinks, path traversal, HTML/SVG, and all script/executable binaries (`.js`, `.ts`, `.py`, `.sh`, `.ps1`, `.bat`, `.exe`, `.dll`, `.so`, `.dylib`, `.wasm`, `.node`, etc.).
- **Delay executable code plugins** until full signature verification and sandboxed out-of-process execution are audited — avoiding the VPet Workshop malware re-upload attack class.

---

## 2. Microsoft Store (MSIX — Policy 11.16 & Store Signing)

### Policy 11.16 (Live Generative AI) Checklist
- [x] **In-app AI output reporting (`src/core/aiReport.ts`, `#live-report-output`, `#ai-report-dialog`):** Users can report inaccurate, harmful/unsafe, out-of-character, or injection-related AI replies directly from the companion balloon. Reports scrub secrets (`withoutSecrets`), save locally under `<dataDir>/ai-reports/`, and offer an explicit opt-in GitHub Issue link with zero automatic telemetry.
- [x] **Clear off-machine inference disclosure:** `#remote-inference-badge` visibly indicates whenever an optional OpenAI-compatible server is on the LAN or external internet.
- [ ] **MSIX Packaging & Signing:** Microsoft Store signs submitted MSIX packages using Microsoft's own certificate at no annual cost (removing the SmartScreen blocker for individual developers who cannot use Azure Trusted Signing's 3-year organization requirement). Keep direct GitHub/itch.io NSIS builds signed with an individual IV code-signing certificate (e.g., Certum SimplySign or SSL.com IV + eSigner) once provisioned.

---

## 3. Windows Clean-Room Verification (Item 8)

Run on a clean Windows 11 test machine (no Node.js, Python, or .NET SDK pre-installed) after installing the packaged `.exe` / `.msix`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-clean-windows.ps1 -LaunchSmoke
# For signed release candidates (enforces Valid Authenticode + RFC 3161 timestamp):
powershell -ExecutionPolicy Bypass -File scripts\verify-clean-windows.ps1 -RequireSigned -LaunchSmoke
```

`scripts/verify-clean-windows.ps1` verifies:
- `Astra Navi Desktop.exe` presence, Authenticode validity, and RFC 3161 timestamp (`-RequireSigned`).
- Bundled resources (`assets`, `browser-bridge`, `voice-server`) and native `win-hands.exe` presence + live JSON probes (`ping`, `version`, `volume-get`, `gpu-vram`, `windows`).
- Browser native messaging manifests & HKCU registry keys, Start Menu shortcut, optional OCR & Python voice venv import health (`fastapi`, `uvicorn`), and a 5-second launch smoke check.

---

## 4. Linux & Flathub Assessment

- **Primary Linux Channels:** AppImage + native `.deb` / `.rpm` / Arch AUR packages.
- **Flathub Reality Check:** Flatpak's strict portal sandbox blocks or severely degrades AT-SPI desktop control inspection, global window-title watching, local `llama-server` / Ollama loopback/process management, and SSH agent/socket workflows. Treat Flathub as a secondary "Companion-only" target (hands-off mode) rather than the primary Linux release channel.

---

## 5. Product Focus & Scope Discipline (Item 9)

- **Hero Pitch (Lead With These):**
  1. Private, local-first 3D AI desktop companion (VRM + MMD with VRMA/VMD motion, idle loops, and event reactions).
  2. Real local tool execution + live MCP integration (Home Assistant, local tools) with explicit per-action approval and prompt-injection tainting.
  3. 100% local, user-owned editable memory (pin, correct, forget, and "Why do you remember this?").
  4. Optional OpenAI-compatible server backend (Ollama / LM Studio / `llama-server` on your LAN PC) to remove the 8 GB VRAM barrier.
- **De-Emphasized / Advanced-Only:**
  - Keep SSH Fleet (`#sec-machines`) and custom Search under **Advanced** settings and out of top-level consumer marketing copy.
  - Keep unwired Tier 10 R&D toggles hidden from Settings UI and isolated on `experimental`.
  - **Skip full-duplex speech-to-speech (S2S) for now:** Current open duplex models trade away tool-calling and instruction-following reliability; the local STT -> LLM -> streaming TTS pipeline remains the right architecture.
  - **Distillation / LoRA status:** `src/core/trainingExport.ts` on `experimental` already aligns `formatQwenSft` with `QwenChatWrapper({ variation: "3.5" })` (`<parameter=params>`), and LoRA v4 reached `83%` (below the `>= 88%` runtime gate). Leave runtime LoRA adapters unshipped until DPO/ORPO or `<think>`-preserving distillation clears the gate.

---

## 6. Qwen3.5 MTP GGUF Runtime Check

- **Installed Embedded Runtime (`node-llama-cpp` `3.22.3`, bundled `llama.cpp` `v0.9.0`):**
  - Does **not** expose `draft-mtp` Multi-Token Prediction bindings in JS (`0` `mtp` symbols in `node_modules/node-llama-cpp/dist/`).
- **Upstream `llama.cpp` (`llama-server`) Status:**
  - Upstream `llama-server` natively supports Qwen3.5 MTP GGUF weights via `--spec-type draft-mtp --spec-draft-n-max 3 -np 1`. `buildLlamaCpp10Args({ mtpDraftTokens: 3, ... })` in `src/core/models.ts` provides a scaffolded CLI flag helper (not yet wired into automatic in-app process launching).
  - Published NVIDIA CUDA benchmarks show roughly **1.4x–2.0x** generation speedup on larger tiers (`27B` dense / `35B-A3B` MoE) with ~50–55% draft acceptance; smaller `9B` weights on Apple Silicon Metal often see neutral or slightly slower decode due to MTP head overhead.
  - **Important Constraint:** Upstream `llama.cpp` MTP does not run simultaneously with `--mmproj` or parallel slots (`-np > 1`).
  - **Recommended Path Today:** Users with an external `llama-server` binary can launch a Qwen3.5 MTP GGUF with `--spec-type draft-mtp --spec-draft-n-max 3 -np 1` and connect Astra's **Settings → Mind → OpenAI-compatible server** to it, while Astra's separate loopback **Native Vision Sidecar** (`visionSidecar.ts`) loads `--mmproj` on demand only when `look_at_screen` is called.
