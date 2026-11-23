# Changelog

All notable changes to **Astra Navi Desktop** are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Release Automation & Code Signing:** Tag-triggered multi-platform release workflow (`.github/workflows/release.yml`), RFC 3161 timestamped Windows Authenticode script (`scripts/sign-windows.ps1`) supporting Azure Artifact Signing / SignPath Foundation / PFX, native multi-resolution `assets/icon.ico`, Chromium & Firefox WebExtension packaging (`npm run package:extension`), and strict external release keystore flow for the Android APK (`scripts/build-android.sh --release`).
- **Clean-Room & Cross-Desktop Reliability:** Graceful non-KDE Wayland (GNOME, Hyprland), X11, and Flatpak detection and fallback notices (`detectLinuxDesktopEnvironment`), Klipper -> `wl-paste`/`wl-copy` -> `xclip` -> `xsel` clipboard fallbacks, clear KWin D-Bus degradation messages, and blank Windows 11 VM smoke script (`scripts/verify-clean-windows.ps1`).
- **Day-One Supportability & Launch Compliance:** One-click redacted diagnostics exporter (`Settings -> Her mind -> Export Support Bundle (Redacted)`), GitHub Issue Templates, `PRIVACY.md`, Chrome/Firefox store listing copy (`browser-bridge/STORE_LISTING.md`), SteamCMD auto-discovery (`scripts/publish-store.ts`), expanded commercial dependency `NOTICE.md`, and `store/` launch kit.

## [0.1.0] - Initial Open-Core Release

### Added
- **Original 3D Chibi AI Navigator (`Astra Navi`):** Custom-rigged Babylon.js / MMD desktop companion created in Blender with cel-shaded PBR shaders, eye tracking, blink, idle motion, lip-sync visemes, and encrypted local BYO-MMD `.pmx` bundle support.
- **Local-First LLM Inference & Hardware Auto-Tuner:** On-device GGUF execution (`node-llama-cpp`) across Small (`Qwen3.5 4B`), Standard (`Qwen3.5 9B`), Large (`Qwen3.8 27B`), and Workstation XL (`Qwen3.5 72B`) tiers with automatic VRAM/RAM profiling and game-aware GPU yield.
- **Security Gating & Evaluation Suite:** Explicit confirmation gates, `untrusted` indirect-injection defenses, static rule auditing (`npm run eval -- --audit`), injection fuzzer (`npm run eval -- --fuzz`), prompt budget checks (`npm run prompt-size`), and two-stage tool routing (`npm run route-check`).
- **Native Desktop & Cross-Device Integration:** Persistent NativeAOT `win-hands.exe` UI Automation/SendInput backend on Windows, KWin/AT-SPI integration on KDE Wayland, Qwen3-TTS / Kokoro-82M / Moonshine / Whisper local voice stack, cross-platform dependency bootstrapper (`npm run setup`), Chromium/Firefox semantic DOM Native Messaging extension, SSH Fleet management, and paired Android Station (`app.astranavi.station`).
