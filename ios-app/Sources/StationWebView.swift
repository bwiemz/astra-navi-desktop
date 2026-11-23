import SwiftUI
import WebKit

/// Edge-to-edge non-persistent WKWebView shell for Astra Station with pinned LAN TLS validation.
public struct StationWebView: UIViewRepresentable {
    public let url: URL
    public let pinnedSha256Hex: String

    public init(url: URL, pinnedSha256Hex: String) {
        self.url = url
        self.pinnedSha256Hex = pinnedSha256Hex
    }

    public final class Coordinator {
        let delegate: PinnedSessionDelegate
        init(pinnedSha256Hex: String) {
            self.delegate = PinnedSessionDelegate(expectedSha256Hex: pinnedSha256Hex)
        }
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator(pinnedSha256Hex: pinnedSha256Hex)
    }

    public func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator.delegate
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.load(URLRequest(url: url))
        return webView
    }

    public func updateUIView(_ webView: WKWebView, context: Context) {
        if webView.url != url {
            webView.load(URLRequest(url: url))
        }
    }
}
