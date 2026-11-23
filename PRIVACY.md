# Privacy Policy — Astra Navi Desktop & Browser Bridge

_Last updated: 2026-11-22_

**Astra Navi Desktop** is built around a strict **local-first** guarantee: your conversations, memory, screen captures, microphone audio, SSH keys, and local AI inference remain on your own hardware.

## 1. Zero Telemetry or Cloud Accounts
- **No analytics or crash reporting phone-home:** Astra Navi Desktop contains no telemetry SDKs, usage trackers, ad networks, or automatic crash uploaders.
- **No cloud accounts or paywalled telemetry:** Neither the Community (open-core) nor the Supporter Edition sends conversation content, prompts, or desktop state to the developer or third-party AI APIs.

## 2. Where Local Data Is Stored
On desktop systems, user state is written outside the source/install folder to:
- **Primary data directory:** `~/.local/share/astra-navi/` (or `$XDG_DATA_HOME/astra-navi`, `%USERPROFILE%\.local\share\astra-navi` on Windows)
- **Legacy upgrade fallback:** If an existing install from `~/.local/share/ai-chan/` exists and `astra-navi/` does not, it is read automatically without uploading anything.

Stored artifacts include local configuration (`config.json`), SQLite database (`her.db`), optional conversation history (`conversations.jsonl` — can be disabled or cleared anytime via **Forget them all…**), optional encrypted BYO-MMD model bundle, and optional local trace logs (`traces.jsonl`, off by default).

- **Live screen watches & notifications in memory:** When Screen Watch, PC Audio buffer, or Notification Reading is enabled by the user, transient observations stay in volatile RAM and are never persisted to disk unless explicitly asked.

## 3. Opt-In External Network Requests
Astra Navi makes outbound requests only when you trigger or configure the following explicit features:
1. **Model & Runtime Downloads:** Downloading selected open-weight GGUF brains (`Qwen3.5` / `Qwen3.8`), speech models (`Qwen3-TTS`, `Kokoro-82M`, `Moonshine`, `Whisper`, `Silero VAD`), OCR ONNX weights, or Python runtime tooling (`uv`) directly from Hugging Face / PyPI / upstream mirrors.
2. **Public Knowledge Lookups:** Read-only queries to public APIs (`Wikipedia`, `DuckDuckGo Instant Answer`, `Stack Exchange`, `Arch Linux Wiki`, `Hacker News / Algolia`, `Open-Meteo`) when asked a web/weather question.
3. **Optional Configured Search:** User-supplied local SearXNG URL or user-supplied Brave Search API key (`config.json`).
4. **LAN Station & SSH Fleet (User-Paired Only):** TLS-encrypted Station traffic on your local network with user-paired devices, and SSH connections strictly to user-enrolled host keys under `fleet/`.
5. **Untrusted Input Protection:** Pages/emails/notifications fetched from outside are scanned with indirect prompt-injection guards, and high-risk tool actions require explicit confirmation.

## 4. Browser Bridge WebExtension (`browser-bridge`)
- The Astra Navi Browser Bridge extension (`app.astranavi.dom_bridge`) communicates **solely over local stdio Native Messaging** with the Astra Navi Desktop app running on the same computer.
- It **does not** open external HTTP connections, transmit browsing history to any remote server, inject advertisements, or collect analytics.
- DOM snapshots and safe clicks/text entry happen only when the desktop app explicitly requests active-tab inspection or user-approved form actions.

## 5. Redacted Support Bundles
If you use **Settings -> Her mind -> Export Support Bundle (Redacted)** to share diagnostics for troubleshooting:
- Conversation transcripts, long-term memory, journal entries, Brave/SearXNG keys, passwords, Station usernames, SSH hostnames, email addresses, IPv4 addresses, URL query strings, PEM/SSH keys, and local usernames/home paths are **excluded or scrubbed before the file is saved**.
- Support bundles are written strictly locally (`0o600` permissions on POSIX) for you to inspect before choosing whether to attach them to a GitHub issue.

## 6. Contact & Security Reporting
For privacy questions or security vulnerability reports, open a private GitHub Security Advisory per [`SECURITY.md`](SECURITY.md).
