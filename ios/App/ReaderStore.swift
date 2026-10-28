import Foundation
import SwiftUI
import BuffReaderCore

enum ReaderTab: Int, CaseIterable {
    case overview = 0, orders, holdings, profit, alchemy
}

/// Injectable only at construction; production always uses the device Keychain.
struct ReaderCredentials {
    var read: () throws -> String?
    var save: (String) throws -> Void
    var remove: () throws -> Void
    static let keychain = Self(read: KeychainStore.read, save: KeychainStore.save, remove: KeychainStore.remove)
}

@MainActor
final class ReaderStore: ObservableObject {
    @Published private(set) var profiles: [Profile] = []
    @Published private(set) var selectedProfileID = ""
    @Published private(set) var overview: OverviewResponse?
    @Published private(set) var syncStatus: SyncStatusResponse?
    @Published private(set) var orders: [OrderRow] = []
    @Published private(set) var holdings: [HoldingRow] = []
    @Published private(set) var report: ReportResponse?
    @Published private(set) var alchemy: AlchemyResponse?
    @Published private(set) var alchemyRows: [AlchemyRow] = []
    @Published private(set) var alchemyLoading = false
    @Published private(set) var alchemyError: String?
    @Published var alchemySearch = "" { didSet { if oldValue != alchemySearch { invalidate(.alchemy) } } }
    @Published var alchemyFrom = "" { didSet { if oldValue != alchemyFrom { invalidate(.alchemy) } } }
    @Published var alchemyTo = "" { didSet { if oldValue != alchemyTo { invalidate(.alchemy) } } }
    @Published private(set) var orderTotal = 0
    @Published private(set) var holdingTotal = 0
    @Published private(set) var accountLoading = false
    @Published private(set) var ordersLoading = false
    @Published private(set) var holdingsLoading = false
    @Published private(set) var reportLoading = false
    @Published private(set) var configured = false
    @Published private(set) var connectionMessage: String?
    @Published private(set) var accountError: String?
    @Published private(set) var ordersError: String?
    @Published private(set) var holdingsError: String?
    @Published private(set) var reportError: String?
    @Published var selectedCurrency = "CNY" { didSet { if oldValue != selectedCurrency { invalidate(.holdings); invalidate(.profit) } } }
    @Published var orderPlatform = "all" { didSet { if oldValue != orderPlatform { invalidate(.orders) } } }
    @Published var orderDirection = "all" { didSet { if oldValue != orderDirection { invalidate(.orders) } } }
    @Published var orderSearch = "" { didSet { if oldValue != orderSearch { invalidate(.orders) } } }
    @Published var holdingSearch = "" { didSet { if oldValue != holdingSearch { invalidate(.holdings) } } }
    @Published var selectedTab: ReaderTab = .overview
    @Published var showSettings = false
    @Published private(set) var selectionRevision = UUID()
    @Published private(set) var refreshing = false
    @Published private(set) var lastRefreshedAt: Date?
    @Published private(set) var pendingRefreshTabs: Set<ReaderTab> = []
    @Published private(set) var baseURL: String
    private var client: APIClient?
    private var fence = SelectionFence(profileID: "")
    private var profilesGeneration = UUID()
    private var ordersGeneration = UUID()
    private var holdingsGeneration = UUID()
    private var reportGeneration = UUID()
    private var alchemyGeneration = UUID()
    private var alchemyPage = 0
    private var orderPage = 0
    private var holdingPage = 0
    private var accountTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var refreshGeneration = UUID()
    private var configurationGeneration = UUID()
    private var accountGeneration = UUID()
    private let defaults: UserDefaults
    private let credentials: ReaderCredentials
    private let makeClient: (ClientConfiguration) -> APIClient
    private let now: () -> Date
    private var loadedKeys: [ReaderTab: String] = [:]
    private var loadedAt: [ReaderTab: Date] = [:]
    private var loadingKeys: [ReaderTab: String] = [:]
    private var bootstrapAttempted = false

    init(defaults: UserDefaults = .standard, credentials: ReaderCredentials = .keychain,
         makeClient: @escaping (ClientConfiguration) -> APIClient = { APIClient(configuration: $0) },
         now: @escaping () -> Date = Date.init) {
        self.defaults = defaults; self.credentials = credentials; self.makeClient = makeClient; self.now = now
        baseURL = defaults.string(forKey: "reader.baseURL") ?? ClientConfiguration.defaultBaseURL
        selectedProfileID = defaults.string(forKey: "reader.selectedProfile") ?? ""
        fence = SelectionFence(profileID: selectedProfileID)
        selectionRevision = fence.generation
        do {
            if let token = try credentials.read() {
                client = makeClient(try ClientConfiguration(baseURL: baseURL, accessToken: token))
                configured = true
            }
        } catch { connectionMessage = error.localizedDescription }
    }
    var selectedProfile: Profile? { profiles.first { $0.id == selectedProfileID } }
    var currencyOverview: CurrencyOverview? { overview?.currencies.first { $0.currencyCode == selectedCurrency } }
    var currencies: [String] {
        let values = overview?.currencies.map(\.currencyCode) ?? []
        return values.isEmpty ? ["CNY"] : values
    }
    var orderHasMore: Bool { orders.count < orderTotal }
    var holdingHasMore: Bool { holdings.count < holdingTotal }
    var alchemyHasMore: Bool { alchemyRows.count < (alchemy?.total ?? 0) }
    var alchemyFilterKey: String { queryKey(for: .alchemy) }
    var visibleRequestKey: String { queryKey(for: selectedTab) + "|\(configured)|\(selectedProfile != nil)" }

    private func queryKey(for tab: ReaderTab) -> String {
        let filters: [String]
        switch tab {
        case .orders: filters = [orderPlatform, orderDirection, orderSearch]
        case .holdings: filters = [selectedCurrency, holdingSearch]
        case .profit: filters = [selectedCurrency]
        case .alchemy: filters = [alchemySearch, alchemyFrom, alchemyTo]
        case .overview: filters = []
        }
        return ([selectionRevision.uuidString, String(tab.rawValue)] + filters).joined(separator: "|")
    }
    private func needsLoad(_ tab: ReaderTab, force: Bool) -> Bool {
        let key = queryKey(for: tab)
        if loadingKeys[tab] == key { return false }
        return force || loadedKeys[tab] != key || loadedAt[tab].map { now().timeIntervalSince($0) >= 60 } != false
    }
    private func didLoad(_ tab: ReaderTab, key: String) {
        loadedKeys[tab] = key; loadedAt[tab] = now(); pendingRefreshTabs.remove(tab)
    }
    private func invalidate(_ tab: ReaderTab) {
        loadedKeys[tab] = nil; loadedAt[tab] = nil; loadingKeys[tab] = nil
        pendingRefreshTabs.remove(tab)
        switch tab {
        case .orders:
            ordersGeneration = UUID(); orders = []; orderTotal = 0; orderPage = 0; ordersError = nil; ordersLoading = false
        case .holdings:
            holdingsGeneration = UUID(); holdings = []; holdingTotal = 0; holdingPage = 0; holdingsError = nil; holdingsLoading = false
        case .profit:
            reportGeneration = UUID(); report = nil; reportError = nil; reportLoading = false
        case .alchemy:
            alchemyGeneration = UUID(); alchemy = nil; alchemyRows = []; alchemyPage = 0; alchemyError = nil; alchemyLoading = false
        case .overview: break
        }
    }
    func loadVisibleModule(force: Bool = false) async {
        guard configured, selectedProfile != nil else { return }
        switch selectedTab {
        case .overview: break
        case .orders: await loadOrders(force: force)
        case .holdings: await loadHoldings(force: force)
        case .profit: await loadReport(force: force)
        case .alchemy: await loadAlchemy(force: force)
        }
    }

    /// SwiftUI owns this loop and cancels it when the scene leaves the foreground.
    func runForegroundRefresh() async {
        while !Task.isCancelled {
            await refreshIfNeeded()
            do { try await Task.sleep(for: .seconds(60)) } catch { return }
        }
    }

    func importConnection(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true, let size = values.fileSize, size <= 8192 else { throw ReaderError.invalidResponse }
            let value = try JSONDecoder().decode(ConnectionFile.self, from: Data(contentsOf: url))
            _ = try value.validated()
            try await configure(baseURL: value.baseURL, token: value.accessToken)
        } catch { if !isCancelled(error) { connectionMessage = error.localizedDescription } }
    }
    func configure(baseURL: String, token: String) async throws {
        let configuration = try ClientConfiguration(baseURL: baseURL, accessToken: token)
        let generation = UUID(); configurationGeneration = generation
        let nextClient = makeClient(configuration)
        // Validate access before replacing a previously working connection.
        let result = try await nextClient.fetch(ProfilesResponse.self, resource: "profiles")
        try Task.checkCancellation()
        guard generation == configurationGeneration else { throw ReaderError.cancelled }
        try credentials.save(configuration.accessToken)
        self.baseURL = configuration.baseURL.absoluteString
        defaults.set(self.baseURL, forKey: "reader.baseURL")
        cancelRefresh()
        client = nextClient; configured = true; profiles = result.profiles
        profilesGeneration = UUID(); connectionMessage = nil
        let next = result.profiles.contains { $0.id == selectedProfileID } ? selectedProfileID : result.profiles.first?.id ?? ""
        applySelection(next)
        await loadAccount()
        await loadVisibleModule()
    }
    func forgetConnection() {
        do {
            try credentials.remove()
            configurationGeneration = UUID(); cancelRefresh(); profilesGeneration = UUID(); client = nil
            configured = false; profiles = []; connectionMessage = nil
            applySelection("")
        } catch { connectionMessage = error.localizedDescription }
    }
    func refreshIfNeeded() async {
        // Keychain can be locked during launch; retry when the scene becomes active.
        if !configured {
            do {
                if let token = try credentials.read() {
                    client = makeClient(try ClientConfiguration(baseURL: baseURL, accessToken: token))
                    configured = true; connectionMessage = nil
                }
            } catch { connectionMessage = error.localizedDescription }
        }
        if !configured && !bootstrapAttempted {
            bootstrapAttempted = true
            do {
                let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                let imported = try await ConnectionBootstrap.importIfNeeded(documents: documents, configured: configured) { value in
                    try await self.configure(baseURL: value.baseURL, token: value.accessToken)
                }
                if imported { return }
            } catch { connectionMessage = error.localizedDescription }
        }
        guard !Task.isCancelled, configured, lastRefreshedAt.map({ now().timeIntervalSince($0) >= 60 }) != false else { return }
        await reloadProfiles(automatic: true)
    }
    func reloadProfiles(automatic: Bool = false) async {
        if let refreshTask {
            await refreshTask.value
            if !automatic { await loadVisibleModule(force: true) }
            return
        }
        guard let client else { return }
        let generation = UUID(); refreshGeneration = generation; refreshing = true
        let task = Task { await performRefresh(client: client, automatic: automatic) }
        refreshTask = task
        await task.value
        if generation == refreshGeneration { refreshTask = nil; refreshing = false }
    }
    private func performRefresh(client: APIClient, automatic: Bool) async {
        let generation = UUID(); profilesGeneration = generation
        let previousUpload = selectedProfile?.uploadedAt
        do {
            let response = try await client.fetch(ProfilesResponse.self, resource: "profiles")
            try Task.checkCancellation()
            guard generation == profilesGeneration else { return }
            profiles = response.profiles; connectionMessage = nil
            if !response.profiles.contains(where: { $0.id == selectedProfileID }) { applySelection(response.profiles.first?.id ?? "") }
            await loadAccount()
            guard !Task.isCancelled, generation == profilesGeneration else { return }
            let readingLaterPages = (selectedTab == .orders && orderPage > 1)
                || (selectedTab == .holdings && holdingPage > 1) || (selectedTab == .alchemy && alchemyPage > 1)
            if automatic && readingLaterPages {
                if previousUpload != selectedProfile?.uploadedAt { pendingRefreshTabs.insert(selectedTab) }
            } else { await loadVisibleModule(force: true) }
        } catch {
            guard generation == profilesGeneration else { return }
            if !isCancelled(error) { connectionMessage = error.localizedDescription }
        }
    }
    func selectProfile(_ id: String) {
        guard id.isEmpty || profiles.contains(where: { $0.id == id }) else { return }
        guard id != selectedProfileID else { return }
        cancelRefresh()
        applySelection(id)
        guard !id.isEmpty else { return }
        accountTask = Task { await loadAccount() }
    }
    private func cancelRefresh() {
        refreshTask?.cancel(); refreshTask = nil; refreshGeneration = UUID(); profilesGeneration = UUID(); refreshing = false
    }
    private func applySelection(_ id: String) {
        accountTask?.cancel()
        selectedProfileID = id; fence = SelectionFence(profileID: id); clearAccount()
        selectionRevision = fence.generation
        defaults.set(id, forKey: "reader.selectedProfile")
    }
    private func clearAccount() {
        overview = nil; syncStatus = nil; orders = []; holdings = []; report = nil
        alchemy = nil; alchemyRows = []; alchemyPage = 0; alchemyError = nil; alchemyLoading = false; alchemyGeneration = UUID()
        orderTotal = 0; holdingTotal = 0; orderPage = 0; holdingPage = 0
        ordersGeneration = UUID(); holdingsGeneration = UUID(); reportGeneration = UUID()
        accountError = nil; ordersError = nil; holdingsError = nil; reportError = nil
        accountLoading = false; ordersLoading = false; holdingsLoading = false; reportLoading = false
        accountGeneration = UUID(); lastRefreshedAt = nil
        loadedKeys = [:]; loadedAt = [:]; loadingKeys = [:]
        pendingRefreshTabs = []
    }
    func loadAccount() async {
        guard let client, !selectedProfileID.isEmpty, !accountLoading else { return }
        let requestFence = fence, generation = UUID(); accountGeneration = generation
        accountLoading = true; accountError = nil
        defer { if requestFence == fence, generation == accountGeneration { accountLoading = false } }
        do {
            async let overviewResult = client.fetch(OverviewResponse.self, resource: "overview", profileID: requestFence.profileID)
            async let syncResult = client.fetch(SyncStatusResponse.self, resource: "sync-status", profileID: requestFence.profileID)
            let (nextOverview, nextSync) = try await (overviewResult, syncResult)
            try Task.checkCancellation()
            guard requestFence == fence, generation == accountGeneration else { return }
            guard nextOverview.profile.id == requestFence.profileID, nextSync.profileId == requestFence.profileID else { throw ReaderError.invalidResponse }
            overview = nextOverview; syncStatus = nextSync
            if !currencies.contains(selectedCurrency) { selectedCurrency = currencies.first ?? "CNY" }
            if let index = profiles.firstIndex(where: { $0.id == nextOverview.profile.id }) { profiles[index] = nextOverview.profile }
            lastRefreshedAt = now()
        } catch {
            guard requestFence == fence, generation == accountGeneration else { return }
            if !isCancelled(error) { accountError = error.localizedDescription }
        }
    }
    func loadOrders(reset: Bool = true, force: Bool = true) async {
        guard let client, !selectedProfileID.isEmpty else { return }
        if !reset && pendingRefreshTabs.contains(.orders) { await loadOrders(); return }
        let key = queryKey(for: .orders)
        if reset && !needsLoad(.orders, force: force) { return }
        if !reset && (ordersLoading || !orderHasMore) { return }
        let requestFence = fence, generation = UUID(), page = reset ? 1 : orderPage + 1
        ordersGeneration = generation; ordersLoading = true; ordersError = nil
        loadingKeys[.orders] = key
        defer { if requestFence == fence, generation == ordersGeneration { ordersLoading = false; loadingKeys[.orders] = nil } }
        if reset && loadedKeys[.orders] != key { orders = []; orderTotal = 0; orderPage = 0 }
        var query = [URLQueryItem(name: "page", value: String(page)), URLQueryItem(name: "limit", value: "30")]
        if orderPlatform != "all" { query.append(.init(name: "platform", value: orderPlatform)) }
        if orderDirection != "all" { query.append(.init(name: "direction", value: orderDirection)) }
        if !orderSearch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { query.append(.init(name: "q", value: orderSearch)) }
        do {
            let result = try await client.fetch(OrdersResponse.self, resource: "orders", profileID: requestFence.profileID, query: query)
            try Task.checkCancellation()
            guard requestFence == fence, generation == ordersGeneration, key == queryKey(for: .orders) else { return }
            orders = reset ? result.rows : orders + result.rows
            orderTotal = result.total; orderPage = result.page
            didLoad(.orders, key: key)
        } catch {
            guard requestFence == fence, generation == ordersGeneration else { return }
            if !isCancelled(error) { ordersError = error.localizedDescription }
        }
    }
    func loadHoldings(reset: Bool = true, force: Bool = true) async {
        guard let client, !selectedProfileID.isEmpty else { return }
        if !reset && pendingRefreshTabs.contains(.holdings) { await loadHoldings(); return }
        let key = queryKey(for: .holdings)
        if reset && !needsLoad(.holdings, force: force) { return }
        if !reset && (holdingsLoading || !holdingHasMore) { return }
        let requestFence = fence, generation = UUID(), page = reset ? 1 : holdingPage + 1
        holdingsGeneration = generation; holdingsLoading = true; holdingsError = nil
        loadingKeys[.holdings] = key
        defer { if requestFence == fence, generation == holdingsGeneration { holdingsLoading = false; loadingKeys[.holdings] = nil } }
        if reset && loadedKeys[.holdings] != key { holdings = []; holdingTotal = 0; holdingPage = 0 }
        var query = [URLQueryItem(name: "page", value: String(page)), .init(name: "limit", value: "30"), .init(name: "currency", value: selectedCurrency)]
        if !holdingSearch.isEmpty { query.append(.init(name: "q", value: holdingSearch)) }
        do {
            let result = try await client.fetch(HoldingsResponse.self, resource: "holdings", profileID: requestFence.profileID, query: query)
            try Task.checkCancellation()
            guard requestFence == fence, generation == holdingsGeneration, key == queryKey(for: .holdings) else { return }
            holdings = reset ? result.rows : holdings + result.rows
            holdingTotal = result.total; holdingPage = result.page
            didLoad(.holdings, key: key)
        } catch {
            guard requestFence == fence, generation == holdingsGeneration else { return }
            if !isCancelled(error) { holdingsError = error.localizedDescription }
        }
    }
    func loadReport(force: Bool = true) async {
        guard let client, !selectedProfileID.isEmpty else { return }
        let key = queryKey(for: .profit)
        guard needsLoad(.profit, force: force) else { return }
        let requestFence = fence, generation = UUID()
        reportGeneration = generation; reportLoading = true; reportError = nil; loadingKeys[.profit] = key
        defer { if requestFence == fence, generation == reportGeneration { reportLoading = false; loadingKeys[.profit] = nil } }
        if loadedKeys[.profit] != key { report = nil }
        do {
            let result = try await client.fetch(ReportResponse.self, resource: "report", profileID: requestFence.profileID, query: [.init(name: "currency", value: selectedCurrency)])
            try Task.checkCancellation()
            guard requestFence == fence, generation == reportGeneration, key == queryKey(for: .profit) else { return }
            report = result; didLoad(.profit, key: key)
        } catch {
            guard requestFence == fence, generation == reportGeneration else { return }
            if !isCancelled(error) { reportError = error.localizedDescription }
        }
    }
    func loadAlchemy(reset: Bool = true, force: Bool = true) async {
        guard let client, !selectedProfileID.isEmpty else { return }
        if reset && !needsLoad(.alchemy, force: force) { return }
        if !reset && (alchemyLoading || !alchemyHasMore) { return }
        let requestFence = fence, generation = UUID(), filter = alchemyFilterKey, page = reset ? 1 : alchemyPage + 1
        alchemyGeneration = generation; alchemyLoading = true; alchemyError = nil
        loadingKeys[.alchemy] = filter
        defer { if requestFence == fence, generation == alchemyGeneration { alchemyLoading = false; loadingKeys[.alchemy] = nil } }
        if reset && loadedKeys[.alchemy] != filter { alchemy = nil; alchemyRows = []; alchemyPage = 0 }
        var query = [URLQueryItem(name: "page", value: String(page)), .init(name: "limit", value: "20")]
        if !alchemySearch.isEmpty { query.append(.init(name: "q", value: alchemySearch)) }
        if !alchemyFrom.isEmpty { query.append(.init(name: "from", value: alchemyFrom)) }
        if !alchemyTo.isEmpty { query.append(.init(name: "to", value: alchemyTo)) }
        do {
            let result = try await client.fetch(AlchemyResponse.self, resource: "alchemy", profileID: requestFence.profileID, query: query)
            try Task.checkCancellation()
            guard requestFence == fence, generation == alchemyGeneration, filter == alchemyFilterKey else { return }
            guard result.profileId == requestFence.profileID, result.page == page, result.pageSize == 20,
                  result.rows.count <= 20, result.total >= result.rows.count,
                  result.rows.allSatisfy({ $0.profileId == requestFence.profileID }),
                  Set(result.rows.map(\.id)).count == result.rows.count else { throw ReaderError.invalidResponse }
            if !reset, alchemy?.snapshotVersion != result.snapshotVersion {
                loadingKeys[.alchemy] = nil
                await loadAlchemy(); return
            }
            guard reset || Set(alchemyRows.map(\.id)).isDisjoint(with: result.rows.map(\.id)) else { throw ReaderError.invalidResponse }
            alchemyRows = reset ? result.rows : alchemyRows + result.rows
            alchemy = result; alchemyPage = result.page
            didLoad(.alchemy, key: filter)
        } catch {
            guard requestFence == fence, generation == alchemyGeneration, filter == alchemyFilterKey else { return }
            if !isCancelled(error) { alchemyError = error.localizedDescription }
        }
    }
    private func isCancelled(_ error: Error) -> Bool { error is CancellationError || (error as? ReaderError) == .cancelled }
}
