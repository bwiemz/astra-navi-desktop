# Live2D Cubism SDK Licensing Audit & MIT Core Strategy

**Branch:** `experimental` (post-v1 architecture evaluation)
**Date:** November 2026

## 1. Summary Verdict

**Do NOT bundle Live2D Cubism SDK binaries, headers, or core libraries (`libLive2DCubismCore.*`, `CubismFramework`) into the MIT-licensed `astra-navi-desktop` core repository.**

Live2D Cubism SDK should be supported **strictly as an optional BYO (Bring-Your-Own) external bridge/plugin**, while `astra-navi-desktop` core ships a permissive, MIT-compatible **Layered Sprite 2D Rig** specification ([`src/shared/avatar2d.ts`](../src/shared/avatar2d.ts)).

---

## 2. Live2D Cubism SDK Redistribution vs. MIT Compatibility

| Dimension | Live2D Cubism SDK License (Proprietary) | Astra Navi Desktop (`MIT`) |
| --- | --- | --- |
| **Source / Binary Redistribution** | Proprietary agreement restricts redistribution of SDK files/frameworks directly inside open-source repositories; third parties downstream cannot freely fork and sublicense Cubism core under MIT. | Core repository is 100% MIT open-source and must remain cleanly forkable, redistributable, and commercializable without upstream proprietary approvals. |
| **Commercial & Royalty Tiers** | Live2D Cubism Commercial License requires registration and formal tier contracts / publication fees above indie/small-business revenue thresholds (`Small-Scale` vs `General`/`Enterprise`). | Zero royalty or per-seat SDK obligations on Steam / Windows standalone releases or open-source contributors. |
| **Platform Targets** | Separate proprietary native SDKs for Win/macOS/Linux/Android, requiring per-target SDK binary redistribution or Live2D Cubism Web SDK bundling. | Pure Electron TypeScript + BabylonJS/Canvas2D + Apache-2.0 / MIT dependencies only. |
| **DMCA / Store Distribution** | Bundling unlicensed Cubism SDK weights/binaries triggers Steamworks & GitHub licensing compliance risk. | Core passes automated license hygiene checks with zero proprietary SDK blobs. |

---

## 3. Recommended Two-Track Architecture

1. **MIT Core 2D Track (`src/shared/avatar2d.ts`) — Ships in Core:**
   - Open JSON manifest (`LayeredSpriteRigManifestSchema`) + PNG/WebP local sprite layers (`base`, `eyes_open`, `eyes_blink`, `mouth_closed`, `mouth_A/I/U/E/O`, mood overlays, accessories).
   - Zero proprietary runtime dependency, instant <10 MB RAM usage on low-end laptops/iGPUs, deterministic lipsync (`VisemeWeights`) + audio-driven expressive modulation (`ExpressiveCueFrame`).
   - Path-traversal and remote-URL hardened (only safe relative asset paths inside the rig directory).

2. **Optional BYO Live2D Cubism Bridge (External Plugin Only — User Supplied):**
   - Advanced users who own/comply with Live2D Cubism runtime licensing or use VTube Studio / Cubism Web runtime locally can install an external `defaultEnabled: false` bridge plugin (`Avatar2DRenderer` contract) connecting strictly over `localhost`.
   - Zero Cubism code, SDK headers, or proprietary DLL/WASM blobs live in this repository.
