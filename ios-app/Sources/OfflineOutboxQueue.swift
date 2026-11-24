import Foundation

/// Thread-safe, disk-backed capped offline outbox queue for Astra Station iOS.
///
/// Stores pending user utterances or voice-note transcripts locally while away from home
/// Wi-Fi, and replays them only to a validated RFC1918/link-local/mDNS LAN station host.
public actor OfflineOutboxQueue {
    public struct OutboxItem: Codable, Identifiable, Equatable, Sendable {
        public let id: UUID
        public let text: String
        public let createdAt: Date

        public init(id: UUID = UUID(), text: String, createdAt: Date = Date()) {
            self.id = id
            self.text = text
            self.createdAt = createdAt
        }
    }

    private let fileURL: URL
    private let maxItems: Int
    private var items: [OutboxItem]

    public init(fileURL: URL? = nil, maxItems: Int = 25) {
        let baseDir =
            fileURL
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
                .appendingPathComponent("AstraStation", isDirectory: true)
                .appendingPathComponent("outbox.json")
            ?? URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("astra-outbox.json")
        self.fileURL = baseDir
        self.maxItems = max(1, maxItems)
        if let data = try? Data(contentsOf: baseDir),
           let decoded = try? JSONDecoder().decode([OutboxItem].self, from: data)
        {
            self.items = decoded
        } else {
            self.items = []
        }
    }

    public func enqueue(_ rawText: String) -> OutboxItem? {
        let clean = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return nil }
        let clipped = String(clean.prefix(2000))
        let item = OutboxItem(text: clipped)
        items.append(item)
        if items.count > maxItems {
            items.removeFirst(items.count - maxItems)
        }
        persist()
        return item
    }

    public func list() -> [OutboxItem] {
        items
    }

    public func remove(id: UUID) {
        items.removeAll { $0.id == id }
        persist()
    }

    public func flush(
        to baseURL: URL,
        bearerToken: String,
        pinnedSession: URLSession = .shared
    ) async -> Int {
        guard Self.isPrivateLanURL(baseURL), !items.isEmpty else { return 0 }
        let sayURL = baseURL.appendingPathComponent("say")
        var sentCount = 0

        for item in items {
            var request = URLRequest(url: sayURL)
            request.httpMethod = "POST"
            request.timeoutInterval = 8
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if !bearerToken.isEmpty {
                request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
            }
            let payload = ["text": item.text]
            guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
                remove(id: item.id)
                continue
            }
            request.httpBody = body
            do {
                let (_, response) = try await pinnedSession.data(for: request)
                if let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) {
                    remove(id: item.id)
                    sentCount += 1
                } else {
                    break
                }
            } catch {
                break
            }
        }
        return sentCount
    }

    public static func isPrivateLanURL(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased(), !host.isEmpty else { return false }
        if host == "localhost" || host == "127.0.0.1" || host.hasSuffix(".local") {
            return true
        }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0 ... 255).contains($0) }) else {
            return false
        }
        if octets[0] == 10 { return true }
        if octets[0] == 172, (16 ... 31).contains(octets[1]) { return true }
        if octets[0] == 192, octets[1] == 168 { return true }
        if octets[0] == 100, (64 ... 127).contains(octets[1]) { return true }
        return false
    }

    private func persist() {
        let dir = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(items) {
            try? data.write(to: fileURL, options: [.atomic, .completeFileProtection])
        }
    }
}
