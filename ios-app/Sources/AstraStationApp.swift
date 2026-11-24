import LocalAuthentication
import SwiftUI

@main
public struct AstraStationApp: App {
    @StateObject private var discovery = StationDiscovery()
    @AppStorage("astra_station_url") private var stationUrlString = ""
    @AppStorage("astra_station_cert_sha256") private var stationCertSha256 = ""
    @AppStorage("astra_station_token") private var stationToken = ""
    @State private var unlocked = false
    @State private var authError = ""
    private let outbox = OfflineOutboxQueue()

    public init() {}

    public var body: some Scene {
        WindowGroup {
            Group {
                if let url = URL(string: stationUrlString), !stationCertSha256.isEmpty {
                    if unlocked {
                        StationWebView(url: url, pinnedSha256Hex: stationCertSha256)
                            .ignoresSafeArea(.container, edges: .bottom)
                    } else {
                        unlockView
                    }
                } else {
                    pairingSetupView
                }
            }
            .onAppear {
                discovery.start()
                Task {
                    if let url = URL(string: stationUrlString), !stationCertSha256.isEmpty {
                        _ = await outbox.flush(to: url, bearerToken: stationToken)
                    }
                }
            }
            .onDisappear { discovery.stop() }
        }
    }

    private var unlockView: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.shield")
                .font(.system(size: 44))
            Text("Unlock Astra Station")
                .font(.title2.bold())
            if !authError.isEmpty {
                Text(authError).foregroundColor(.red).font(.footnote)
            }
            Button("Authenticate with Face ID / Passcode") {
                authenticateDevice()
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
        .onAppear { authenticateDevice() }
    }

    private var pairingSetupView: some View {
        NavigationView {
            Form {
                Section("Discovered on Home Wi-Fi (_astranavi._tcp)") {
                    if discovery.stations.isEmpty {
                        Text("Searching local network…")
                            .foregroundColor(.secondary)
                    } else {
                        ForEach(discovery.stations) { station in
                            Button(station.name) {
                                stationUrlString = station.urlString
                            }
                        }
                    }
                }
                Section("Paired Station Address & TLS Fingerprint") {
                    TextField("https://192.168.1.10:7474/", text: $stationUrlString)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                    TextField("SHA-256 certificate fingerprint", text: $stationCertSha256)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                }
            }
            .navigationTitle("Astra Station iOS")
        }
    }

    private func authenticateDevice() {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            authError = error?.localizedDescription ?? "Device authentication unavailable."
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Astra Station") { ok, err in
            DispatchQueue.main.async {
                if ok {
                    unlocked = true
                    authError = ""
                } else {
                    authError = err?.localizedDescription ?? "Authentication canceled."
                }
            }
        }
    }
}
