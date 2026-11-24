import Foundation
#if canImport(AppIntents)
import AppIntents

@available(iOS 16.0, *)
public struct AskAstraIntent: AppIntent {
    public static var title: LocalizedStringResource = "Ask Astra Navi"
    public static var description = IntentDescription(
        "Send a short local request to your paired Astra Navi station or queue it while away."
    )

    @Parameter(title: "Prompt")
    public var prompt: String

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let outbox = OfflineOutboxQueue()
        let saved = await outbox.enqueue(prompt)
        let stationString = UserDefaults.standard.string(forKey: "astra_station_url") ?? ""
        if let url = URL(string: stationString), OfflineOutboxQueue.isPrivateLanURL(url) {
            let token = UserDefaults.standard.string(forKey: "astra_station_token") ?? ""
            let flushed = await outbox.flush(to: url, bearerToken: token)
            if flushed > 0 {
                return .result(dialog: "Sent to Astra Navi.")
            }
        }
        if saved != nil {
            return .result(dialog: "Queued offline for Astra Navi when back on home Wi-Fi.")
        }
        return .result(dialog: "Please say something to send to Astra Navi.")
    }
}

@available(iOS 16.0, *)
public struct QuickVoiceNoteIntent: AppIntent {
    public static var title: LocalizedStringResource = "Save Quick Note for Astra"
    public static var description = IntentDescription("Queues a quick local note in Astra Station.")

    @Parameter(title: "Note")
    public var note: String

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let outbox = OfflineOutboxQueue()
        _ = await outbox.enqueue("Remember note: \(note)")
        return .result(dialog: "Saved note in Astra Station outbox.")
    }
}
#endif
