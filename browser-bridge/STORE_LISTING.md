# Astra Navi Local DOM Bridge — Chrome Web Store & Firefox Add-ons Listing

This document contains the submission metadata, permission justifications, and privacy declarations for publishing `browser-bridge/` (`app.astranavi.dom_bridge`) on the **Chrome Web Store** and **Firefox Add-ons (AMO)**.

## Packaging Commands

Build clean store-ready ZIP packages before uploading:

```sh
npm run package:extension
```

Generated artifacts in `dist/`:
- `dist/astra-navi-browser-bridge-chromium-0.1.0.zip` — Chrome Web Store / Edge Add-ons (`background.service_worker`, no `browser_specific_settings`)
- `dist/astra-navi-browser-bridge-firefox-0.1.0.zip` — Firefox AMO (`background.scripts`, keeps `gecko.id: "dom-bridge@astranavi.app"`)
- `dist/browser-bridge-checksums.txt` — SHA-256 checksums for both archives

---

## Store Listing Copy

- **Extension Name:** Astra Navi Local DOM Bridge
- **Short Summary (<= 132 chars):**
  Read-only local DOM and media companion communicating strictly via native messaging with Astra Navi Desktop.
- **Category:** Productivity / Accessibility
- **Language:** English

### Detailed Description
**Astra Navi Local DOM Bridge** connects your local **Astra Navi Desktop** assistant directly to the currently active browser tab using your browser's built-in Native Messaging API (`app.astranavi.dom_bridge`)—without any cloud relay, external telemetry, or background network traffic.

- **Local-Only Architecture:** All page inspection and safe UI actions pass exclusively over local stdio Native Messaging to the Astra Navi Desktop app running on your computer.
- **Untrusted-Content Isolation:** Web page content read through this extension is treated as untrusted data inside Astra Navi Desktop and never grants automatic execution privileges.
- **Zero Remote Collection:** Browsing history, page DOMs, and tab metadata never leave your device.

**Requirement:** Install and run **Astra Navi Desktop**, then enable the native host from the first-run Setup Wizard or by running `npm run setup-browser-bridge`.

---

## Single Purpose Statement
Provides a strictly local stdio Native Messaging bridge (`app.astranavi.dom_bridge`) between the active browser tab and the locally installed Astra Navi Desktop application so the user's on-device assistant can inspect requested page elements or click/fill user-approved targets.

---

## Permission Justifications (`browser-bridge/manifest.json`)

Actual requested keys in `browser-bridge/manifest.json`:

| Permission / Key | Justification |
| --- | --- |
| `activeTab` | Grants temporary, user-initiated access to the currently active tab only when a page inspection or local bridge command is invoked—avoiding permanent broad tab-history access (`tabs` is intentionally **not** requested). |
| `scripting` | Allows injecting read-only DOM extraction and user-approved element click/input helpers into the active tab on demand. |
| `nativeMessaging` | Connects locally via `chrome.runtime.connectNative("app.astranavi.dom_bridge")` / `browser.runtime.connectNative("app.astranavi.dom_bridge")` to the desktop host (`browser-bridge/native-host.mjs`). No remote hosts or WebSockets are used. |
| `content_scripts` (`http://*/*`, `https://*/*`, `document_idle`) | Registers the lightweight helper `content.js` on standard web pages so page-level DOM snapshots respond synchronously when requested by the local desktop bridge. Does not read file URLs (`file://*`) or extension pages, and takes no action unless messaged by the local desktop host. |

---

## Privacy & Data Handling Questionnaire Answers
- **Does the extension collect, store, or transmit user data to external servers?** **No.** All data stays on `localhost` via OS Native Messaging stdio pipes.
- **Does it use remote code?** **No.** All extension scripts (`background.js`, `content.js`) are bundled statically inside the archive.
- **Account required?** **No** (no sign-in required for extension review; functionality requires the local open-source **Astra Navi Desktop** native messaging host, source in `browser-bridge/native-host.mjs`).

## Reviewer Testing Notes
1. Install **Astra Navi Desktop** (or clone https://github.com/bwiemz/astra-navi-desktop and run `npm run setup-browser-bridge`).
2. Load the extension in Chrome/Firefox; check extension service worker/background console showing Native Messaging handshake attempts to `app.astranavi.dom_bridge`.
3. With Astra Navi Desktop open, asking the local assistant to inspect the active browser tab returns clean DOM structure without any external HTTP requests.
