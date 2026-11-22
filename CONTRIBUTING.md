# Contributing to AI-chan Desktop

Contributions are warmly welcome — especially **Windows and macOS backends** via `PlatformAdapter`, evaluation cases (`evals/`), security hardening (`tests/`, `src/core/ruleAudit.ts`), UI improvements, and original character tooling.

## Quick Development Setup

Requirements:
- **Node.js 24 or newer** (`package.json` uses native TypeScript execution for CLI scripts)
- **npm**

Install and run the full check suite:

```sh
npm install
npm run check                  # TypeScript typecheck, ESLint, and Vitest unit tests
npm run build                  # Electron main + preload + renderer build
npm run eval -- --fuzz         # 500-case deterministic security/taint fuzz gate
npm run eval -- --audit        # Static policy & rule-conflict audit
```

### Running the Full LLM Eval Suite

If you have a local GGUF model configured or downloaded:

```sh
npm run eval                                     # Full suite using auto-selected model
AI_CHAN_BRAIN=small npm run eval -- --label dev  # Explicit brain tier
npm run eval -- --cpu 4 --cases tools/timer      # Run subset on CPU
```

See [evals/README.md](evals/README.md) for case authoring, scoring rules, and trace replay (`--replay`).

## Coding Conventions

- Strict TypeScript across both `tsconfig.node.json` and `tsconfig.web.json`: no `any`, explicit `type` imports (`import type ...`), and `.ts` extensions on relative imports in Node/core modules.
- **Keep `src/core/` Electron-free and OS-agnostic:** never import Electron or platform-specific binaries directly outside dedicated platform adapters or `src/main/`.
- Keep `src/renderer/` free of Node built-ins (`node:*`).
- Run `npm run check` before opening a pull request.

## Adding or Extending OS Backends (`PlatformAdapter`)

Operating-system integration lives behind [`PlatformAdapter`](src/core/platform/adapter.ts), keeping security invariants (full-name accessibility control matching, foreground-window re-verification before clicks, terminal typing protections, and hands-off enforcement) uniform across platforms:

| File | Scope |
| ---- | ----- |
| `src/core/platform/adapter.ts` | `PlatformAdapter` contract & capability interfaces |
| `src/core/platform/linux.ts` | `LinuxPlatformAdapter` (KDE KWin, AT-SPI, PipeWire, Spectacle) |
| `src/core/platform/windows.ts` | `WindowsPlatformAdapter` (Win32 / UIA / WGC / WASAPI / DXGI starter backend) |
| `src/core/platform/winSandbox.ts` | Windows execution & sandbox helpers |
| `src/core/platform/safety.ts` | Cross-platform desktop safety guards |

### How to Contribute Windows Hardening or a `macOS` (`darwin`) Backend

1. **Windows testers & contributors:** Expand `WindowsPlatformAdapter` in `src/core/platform/windows.ts` and `src/core/platform/winSandbox.ts`, add real Windows smoke verification notes, and ensure fallback safety invariants pass unit tests (`tests/`).
2. **macOS (`darwin`) contributors:**
   - Extend `PlatformAdapter["platform"]` cleanly (for example `"linux" | "win32" | "darwin"`) in `src/core/platform/adapter.ts`.
   - Implement `MacOSPlatformAdapter` in `src/core/platform/macos.ts` covering `windowManager` (CGWindowList / AppleScript / AX), `accessibilityTree` (macOS NSAccessibility), `inputInjector`, `screenCapture` (`screencapture` / ScreenCaptureKit), `audioLoopback`, `media` (`nowplaying` / AppleScript), and `systemNotices`.
   - Wire platform selection cleanly without weakening `src/core/platform/safety.ts` or `src/core/permissions.ts`.
   - Include mock/unit tests under `tests/` verifying fallback behavior when permissions (Screen Recording / Accessibility) are not granted.

## Character Assets & Rebuilding Astra Navi

The default character **Astra Navi** (`assets/models/ai-navigator/`) is 100% original (CC-BY-4.0 / MIT) and procedurally generated with Blender 5.3:

```sh
blender --background --python-exit-code 1 --python scripts/blender/build_navigator_mmd.py -- \
  --out-dir assets/models/ai-navigator
npx vitest run tests/customModel.test.ts
```

### Intellectual Property Policy

- **Never commit third-party, fan-art, game-ripped, or proprietary MMD models** (`.pmx`, `.pmd`, `.vrm`, `.fbx`, `.aichan`) into this repository. `.gitignore` explicitly blocks character binaries outside the whitelisted original asset `assets/models/ai-navigator/ai-navigator.pmx`.
- Users who own or hold fan-use rights to other MMD models can import them locally via **Import character model…** or `npm run import-model`.
