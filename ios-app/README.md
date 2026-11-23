# Astra Station for iOS

Two ways to use Astra Station from an iPhone or iPad on your home network:

1. **Installable PWA (Zero App Store / Zero Xcode Required):**
   - Open the paired Astra Station HTTPS URL in iOS Safari (`Add to Home Screen`).
   - Served with `/manifest.webmanifest`, `/apple-touch-icon.png`, iOS standalone meta tags, safe-area inset styling, and a pass-through Service Worker (`/sw.js`) that never caches credentials or API responses.

2. **Thin Native SwiftUI Wrapper (`ios-app/`):**
   - Mirrors the security posture of `phone-app/` (Android):
     - Local LAN discovery via `Network.NWBrowser` (`_astranavi._tcp.`)
     - Strict SHA-256 TLS leaf certificate pinning (`PinnedSessionDelegate.swift`)
     - `LAContext` Face ID / Touch ID unlock gate before opening the paired station (`AstraStationApp.swift`)
     - Non-persistent `WKWebsiteDataStore.nonPersistent()` web view (`StationWebView.swift`)

## Building on macOS

Building the native iOS app requires Xcode 15+ on macOS (not available on Linux/Windows CI runners):

```bash
cd ios-app
swift package resolve
open Package.swift
```

Select an iOS 16+ simulator or device target in Xcode and run.
