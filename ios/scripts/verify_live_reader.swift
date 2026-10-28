import Foundation

// Compile alongside Sources/BuffReaderCore/*.swift. The connection file is read
// only from the supplied private path; no credentials or record details print.
@main
struct VerifyLiveReader {
    static func main() async {
        var checkpoint = "connection"
        do {
            guard CommandLine.arguments.count == 2 else { throw ReaderError.invalidResponse }
            let file = URL(fileURLWithPath: CommandLine.arguments[1])
            let connection = try JSONDecoder().decode(ConnectionFile.self, from: Data(contentsOf: file))
            let client = APIClient(configuration: try connection.validated())
            checkpoint = "profiles"
            let profiles = try await client.fetch(ProfilesResponse.self, resource: "profiles")
            guard Set(profiles.profiles.map(\.id)) == Set(["account-1", "account-2"]), profiles.profiles.count == 2 else { throw ReaderError.invalidResponse }
            var requests = 1
            for profile in profiles.profiles {
                checkpoint = profile.id + "/overview"
                let overview = try await client.fetch(OverviewResponse.self, resource: "overview", profileID: profile.id); requests += 1
                guard overview.profile.id == profile.id else { throw ReaderError.invalidResponse }
                checkpoint = profile.id + "/orders"
                let orders = try await client.fetch(OrdersResponse.self, resource: "orders", profileID: profile.id, query: [.init(name: "page", value: "1"), .init(name: "limit", value: "30")]); requests += 1
                guard orders.page == 1, orders.rows.count <= 30, orders.total >= orders.rows.count else { throw ReaderError.invalidResponse }
                checkpoint = profile.id + "/holdings"
                let holdings = try await client.fetch(HoldingsResponse.self, resource: "holdings", profileID: profile.id); requests += 1
                guard holdings.total >= holdings.rows.count else { throw ReaderError.invalidResponse }
                checkpoint = profile.id + "/report"
                let report = try await client.fetch(ReportResponse.self, resource: "report", profileID: profile.id); requests += 1
                if let summary = overview.currencies.first(where: { $0.currencyCode == report.currency }) {
                    guard summary.profitCents == report.summary.profitCents, summary.knownProfitCents == report.summary.knownProfitCents else { throw ReaderError.invalidResponse }
                }
                checkpoint = profile.id + "/sync-status"
                let sync = try await client.fetch(SyncStatusResponse.self, resource: "sync-status", profileID: profile.id); requests += 1
                guard sync.profileId == profile.id else { throw ReaderError.invalidResponse }
                checkpoint = profile.id + "/alchemy"
                let alchemy = try await client.fetch(AlchemyResponse.self, resource: "alchemy", profileID: profile.id); requests += 1
                guard alchemy.profileId == profile.id, alchemy.page == 1, alchemy.pageSize == 20,
                      alchemy.total >= alchemy.rows.count, alchemy.summary.craftCount == alchemy.total else { throw ReaderError.invalidResponse }
                if profile.state == "not-synced" {
                    guard profile.recordCount == 0, profile.uploadedAt == nil, profile.collectedAt == nil,
                          overview.currencies.isEmpty, orders.total == 0, holdings.total == 0,
                          sync.uploadedAt == nil, sync.collectedAt == nil, alchemy.total == 0, alchemy.archives.isEmpty else { throw ReaderError.invalidResponse }
                }
            }
            print("Verified read-only Swift API consumer: \(requests) responses, two isolated profiles, empty-profile semantics and report totals consistent.")
        } catch {
            // The checkpoint is a fixed endpoint name, never response content.
            fputs("Reader verification failed at \(checkpoint).\n", stderr)
            exit(1)
        }
    }
}
