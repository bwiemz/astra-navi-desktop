import CryptoKit
import Foundation
import Security
import WebKit

/// Strictly pins TLS connections against the paired desktop station's SHA-256 certificate fingerprint.
public final class PinnedSessionDelegate: NSObject, URLSessionDelegate, WKNavigationDelegate {
    private let expectedSha256Hex: String

    public init(expectedSha256Hex: String) {
        self.expectedSha256Hex = expectedSha256Hex.lowercased().replacingOccurrences(of: ":", with: "")
    }

    public static func evaluateServerTrust(_ trust: SecTrust, expectedHex: String) -> Bool {
        guard !expectedHex.isEmpty else { return false }
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else {
            return false
        }
        let derData = SecCertificateCopyData(leaf) as Data
        let digest = SHA256.hash(data: derData)
        let actualHex = digest.map { String(format: "%02x", $0) }.joined()
        return constantTimeEqual(actualHex, expectedHex)
    }

    private static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        let ab = Array(a.utf8)
        let bb = Array(b.utf8)
        guard ab.count == bb.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<ab.count {
            diff |= ab[i] ^ bb[i]
        }
        return diff == 0
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              Self.evaluateServerTrust(trust, expectedHex: expectedSha256Hex) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    public func webView(
        _ webView: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              Self.evaluateServerTrust(trust, expectedHex: expectedSha256Hex) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}
