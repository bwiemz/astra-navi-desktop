import Foundation
import Network

/// Discovers local Astra Navi Desktop station instances advertised via Bonjour (`_astranavi._tcp.`).
@MainActor
public final class StationDiscovery: ObservableObject {
    public struct DiscoveredStation: Identifiable, Equatable {
        public let id: String
        public let name: String
        public let urlString: String
    }

    @Published public private(set) var stations: [DiscoveredStation] = []
    private var browser: NWBrowser?

    public init() {}

    public func start() {
        stop()
        let params = NWParameters.tcp
        params.includePeerToPeer = false
        let browser = NWBrowser(for: .bonjour(type: "_astranavi._tcp", domain: "local."), using: params)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                var found: [DiscoveredStation] = []
                for result in results {
                    if case let .service(name, type, domain, _) = result.endpoint {
                        let safeHost = "\(name).\(type)\(domain)".trimmingCharacters(in: CharacterSet(charactersIn: "."))
                        found.append(DiscoveredStation(
                            id: safeHost,
                            name: name,
                            urlString: "https://\(name).local:7474/"
                        ))
                    }
                }
                self.stations = found
            }
        }
        browser.start(queue: .main)
        self.browser = browser
    }

    public func stop() {
        browser?.cancel()
        browser = nil
    }
}
