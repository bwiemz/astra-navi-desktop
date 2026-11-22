# Security Model & Reporting

AI-chan Desktop runs open-weight language, speech, and vision models locally while giving the assistant bounded desktop, shell, file, calendar, and remote-host capabilities. Because small local models can be misled by untrusted external text (web pages, files, notifications, calendar invites, or command output), every side effect is gated outside the model in TypeScript before execution.

## Architectural Security Boundaries

### 1. Permission Gating (`src/core/permissions.ts`)
- Every tool invocation passes through the policy gate before running.
- Read-only inspection tools (for example allow-listed look-only commands with explicit known flags, reading ordinary files inside allowed paths, reading the agenda, or web lookups) are strictly separated from state-changing actions.
- Commands using wildcards, shell variable expansion, chaining/piping outside safe wrappers, package installs (`pkexec`), credential/browser profile access, window closing, clipboard writes after reading untrusted input, and mutating remote SSH calls always require explicit interactive user approval showing the exact arguments.
- `"Allow for this chat"` is only offered for exact, literal commands without dynamic expansion; dangerous paths (`secrets`, keys, bulk home scans, mutating SSH hosts) are one-shot only and cannot be approved from remote paired devices.

### 2. Untrusted Input Taint & Prompt Injection Controls (`evals/fuzz.ts`, `src/core/missions.ts`, `src/core/agenda.ts`)
- Once external untrusted content enters a turn (web page, third-party file, calendar feed, or program output), downstream state-changing tools escalate to explicit approval.
- Mission steps and standing orders store exact command & host snapshots; any drift in command, host, or address—or restart across sessions—re-prompts the user at the PC before execution.
- Remote station pairing (`src/core/station.ts`, `phone-app/`) enforces private-network address validation, TLS with locally generated certificates, paired-device identity checks, and hard blocks on reading local desktop notifications, screen captures, or sensitive mission steps remotely.

### 3. Follow-Through Verification & Grounding (`src/core/claims.ts`, `src/core/ruleAudit.ts`)
- `claims.ts` verifies assistant claims against actual tool calls executed during the turn so ungrounded hallucinated completion claims are caught and re-run or annotated.
- `ruleAudit.ts` (`auditSecurityRules`) performs static policy conflict checks across configuration and standing orders (for example catching unsafe standing orders targeting executable/watched paths or overly permissive desktop overrides).

### 4. Character Bundle Isolation (`src/main/modelFiles.ts`, `src/core/characterBundle.ts`)
- The default character **Astra Navi** (`assets/models/ai-navigator/`) is an original CC-BY-4.0 / MIT asset built from scratch in Blender.
- User-imported third-party `.pmx` models are packed locally into an authenticated per-machine encrypted container (`~/.local/share/ai-chan/`) and served in-memory over a private custom protocol inaccessible to external browsers or third parties.

## Reproducing Security Audits & Fuzzing

Run the headless verification gates locally without needing a GPU or live LLM weights:

```sh
# 500-case deterministic fuzz gate across injection, approval, taint & remote boundaries
npm run eval -- --fuzz

# Static rule-conflict and policy audit against configuration & standing orders
npm run eval -- --audit

# Full TypeScript typecheck, ESLint, and unit test suite
npm run check
```

To replay a recorded compressed trace bundle against current permission rules:

```sh
npm run eval -- --replay <bundle.json.gz>
```

And to validate bundled capability plugin manifests and their shipped test cases:

```sh
npm run eval -- --plugin <plugin-dir>
```

## Reporting a Vulnerability

Please **do not** open public GitHub issues for exploitable permission bypasses, remote station authentication flaws, arbitrary command injection vectors, or sandbox escapes.

Instead, report vulnerabilities privately via GitHub Security Advisories on [`bwiemz/ai-chan-desktop`](https://github.com/bwiemz/ai-chan-desktop/security/advisories/new) with:
- A clear reproduction case (minimal prompt, config, or unit/eval fixture)
- The affected module (`src/core/permissions.ts`, `src/core/ruleAudit.ts`, `src/main/`, etc.)
- Impact assessment (for example unauthorized side effect without approval or taint bypass)

Confirmed fixes ship with regression tests under `tests/` and/or `evals/fuzz.ts` / `evals/cases/`.
