import Foundation
import XCTest
import BuffReaderCore
@testable import BuffReaderState

private final class StubServer: @unchecked Sendable {
    struct Reply { let data: Data; var delay: TimeInterval = 0; var status = 200 }
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    var reply: (URLRequest) throws -> Reply = { _ in Reply(data: Data(), status: 500) }
    func respond(_ request: URLRequest) throws -> Reply {
        lock.lock(); requests.append(request); lock.unlock()
        return try reply(request)
    }
    func count(_ resource: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return requests.filter { $0.url?.lastPathComponent == resource }.count
    }
    func profileIDs() -> [String] {
        lock.lock(); defer { lock.unlock() }
        return requests.compactMap { request in
            let parts = request.url!.pathComponents
            return parts.last == "profiles" ? nil : parts[parts.count - 2]
        }
    }
}
private final class StubProtocol: URLProtocol, @unchecked Sendable {
    static var server = StubServer()
    private let lock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "reader.example.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let reply = try Self.server.respond(request)
            DispatchQueue.global().asyncAfter(deadline: .now() + reply.delay) { [self] in
                lock.lock(); defer { lock.unlock() }
                guard !stopped else { return }
                let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: nil)!
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: reply.data)
                client?.urlProtocolDidFinishLoading(self)
            }
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() { lock.lock(); stopped = true; lock.unlock() }
}

@MainActor
final class ReaderStoreTests: XCTestCase {
    private let base = "https://reader.example.invalid/api"
    private var server: StubServer!
    private var defaults: UserDefaults!
    private var suite = ""
    private var now = Date(timeIntervalSince1970: 1_800_000_000)
    private var savedTokens: [String] = []

    override func setUp() async throws {
        suite = "buff-reader-test-" + UUID().uuidString
        defaults = UserDefaults(suiteName: suite)!
        defaults.set(base, forKey: "reader.baseURL")
        server = StubServer(); StubProtocol.server = server
        server.reply = { request in .init(data: try Self.fixture(request)) }
    }
    override func tearDown() async throws { defaults.removePersistentDomain(forName: suite) }

    private func makeStore(profile: String = "account-2") -> ReaderStore {
        defaults.set(profile, forKey: "reader.selectedProfile")
        return ReaderStore(defaults: defaults, credentials: .init(read: { "synthetic-test-readonly-token" }, save: { self.savedTokens.append($0) }, remove: {}), makeClient: { configuration in
            let session = URLSessionConfiguration.ephemeral; session.protocolClasses = [StubProtocol.self]
            return APIClient(configuration: configuration, sessionConfiguration: session)
        }, now: { self.now })
    }
    nonisolated private static func fixture(_ request: URLRequest, version: String = "one") throws -> Data {
        let name = request.url!.lastPathComponent
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("BuffReaderCoreTests/Fixtures")
        let data = try Data(contentsOf: root.appendingPathComponent(name + ".json"))
        if name == "profiles" { return data }
        let profile = request.url!.deletingLastPathComponent().lastPathComponent
        var text = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "account-1", with: profile)
        if name == "orders" { text = text.replacingOccurrences(of: "\"name\":", with: "\"testVersion\":\"\(version)\",\"name\":") }
        var envelope = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        var result = envelope["result"] as! [String: Any]
        if name == "orders" {
            var rows = result["rows"] as! [[String: Any]]
            for i in rows.indices { rows[i]["id"] = "\(profile)-\(version)-\(i)" }
            result["rows"] = rows
        }
        if name == "alchemy" { result["snapshotVersion"] = version }
        envelope["result"] = result
        return try JSONSerialization.data(withJSONObject: envelope)
    }
    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<300 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("Timed out waiting for asynchronous state")
    }

    func testColdLaunchRestoresAccountAndRequestFence() async {
        let store = makeStore()
        await store.refreshIfNeeded()
        XCTAssertEqual(store.selectedProfileID, "account-2")
        XCTAssertEqual(store.overview?.profile.id, "account-2")
        XCTAssertEqual(store.syncStatus?.profileId, "account-2")
        XCTAssertNotNil(store.lastRefreshedAt)
        XCTAssertNil(store.accountError)
        XCTAssertEqual(Set(server.profileIDs()), ["account-2"])
    }
    func testConcurrentStartupRefreshesCoalesce() async {
        server.reply = { request in .init(data: try Self.fixture(request), delay: 0.04) }
        let store = makeStore()
        async let first: Void = store.refreshIfNeeded()
        async let second: Void = store.refreshIfNeeded()
        _ = await (first, second)
        XCTAssertEqual(server.count("profiles"), 1)
        XCTAssertEqual(server.count("overview"), 1)
        XCTAssertFalse(store.refreshing)
        XCTAssertFalse(store.accountLoading)
    }
    func testForegroundRefreshAlsoUpdatesVisibleOrdersAndRespectsFreshness() async {
        let store = makeStore(); store.selectedTab = .orders
        await store.refreshIfNeeded()
        XCTAssertTrue(store.orders.first?.id.contains("one") == true)
        await store.refreshIfNeeded()
        XCTAssertEqual(server.count("profiles"), 1)
        now.addTimeInterval(61)
        server.reply = { request in .init(data: try Self.fixture(request, version: "two")) }
        await store.refreshIfNeeded()
        XCTAssertTrue(store.orders.first?.id.contains("two") == true)
        XCTAssertEqual(server.count("orders"), 2)
    }
    func testSelectingCurrentAccountPreservesDataAndNavigationRevision() async {
        let store = makeStore(); await store.refreshIfNeeded()
        let revision = store.selectionRevision
        store.selectProfile("account-2")
        XCTAssertEqual(store.selectionRevision, revision)
        XCTAssertNotNil(store.overview)
        XCTAssertEqual(server.count("overview"), 1)
    }
    func testLateOldAccountOrdersCannotReplaceNewSelection() async throws {
        let store = makeStore(profile: "account-1"); await store.refreshIfNeeded()
        server.reply = { request in
            .init(data: try Self.fixture(request), delay: request.url!.path.contains("account-1/orders") ? 0.15 : 0)
        }
        let old = Task { await store.loadOrders() }
        try await until { self.server.count("orders") == 1 }
        store.selectProfile("account-2")
        XCTAssertTrue(store.orders.isEmpty)
        XCTAssertNil(store.overview)
        await store.loadOrders()
        await old.value
        try await until { !store.accountLoading && store.overview != nil }
        XCTAssertEqual(store.overview?.profile.id, "account-2")
        XCTAssertTrue(store.orders.allSatisfy { $0.id.hasPrefix("account-2") })
        XCTAssertFalse(store.ordersLoading)
    }
    func testFilterChangesRejectLateResults() async throws {
        let store = makeStore(); await store.refreshIfNeeded()
        server.reply = { request in
            let filtered = request.url!.query?.contains("q=") == true
            return .init(data: try Self.fixture(request, version: filtered ? "filtered" : "old"), delay: filtered ? 0 : 0.12)
        }
        let old = Task { await store.loadOrders() }
        try await until { self.server.count("orders") == 1 }
        store.orderSearch = "测试"
        await store.loadOrders()
        await old.value
        XCTAssertTrue(store.orders.first?.id.contains("filtered") == true)
        XCTAssertFalse(store.ordersLoading)
    }
    func testFailedRefreshRetainsSameAccountDataWithoutAdvancingFreshness() async {
        let store = makeStore(); store.selectedTab = .orders; await store.refreshIfNeeded()
        let date = store.lastRefreshedAt, ids = store.orders.map(\.id)
        now.addTimeInterval(61)
        server.reply = { _ in .init(data: Data(), status: 503) }
        await store.refreshIfNeeded()
        XCTAssertEqual(store.lastRefreshedAt, date)
        XCTAssertEqual(store.orders.map(\.id), ids)
        XCTAssertNotNil(store.connectionMessage)
        XCTAssertFalse(store.refreshing)
    }
    func testAccountFailureIsImmediatelyRetryable() async {
        let store = makeStore()
        server.reply = { request in .init(data: try Self.fixture(request), status: request.url!.lastPathComponent == "overview" ? 503 : 200) }
        await store.refreshIfNeeded()
        XCTAssertNil(store.lastRefreshedAt)
        XCTAssertNotNil(store.accountError)
        server.reply = { request in .init(data: try Self.fixture(request)) }
        await store.refreshIfNeeded()
        XCTAssertNotNil(store.overview)
        XCTAssertNotNil(store.lastRefreshedAt)
        XCTAssertNil(store.accountError)
    }
    func testConnectionReplacementPreservesSelectionButRejectsOldResults() async throws {
        let store = makeStore(); await store.refreshIfNeeded()
        let revision = store.selectionRevision
        server.reply = { request in .init(data: try Self.fixture(request, version: "old"), delay: request.url!.lastPathComponent == "orders" ? 0.15 : 0) }
        let old = Task { await store.loadOrders() }
        try await until { self.server.count("orders") == 1 }
        server.reply = { request in .init(data: try Self.fixture(request, version: "new")) }
        try await store.configure(baseURL: base, token: "new-synthetic-readonly-token")
        await old.value
        XCTAssertEqual(store.selectedProfileID, "account-2")
        XCTAssertNotEqual(store.selectionRevision, revision)
        XCTAssertTrue(store.orders.isEmpty)
        XCTAssertEqual(savedTokens, ["new-synthetic-readonly-token"])
    }
    func testForgetConnectionInvalidatesInFlightConfiguration() async throws {
        let store = makeStore(); await store.refreshIfNeeded()
        server.reply = { request in .init(data: try Self.fixture(request), delay: 0.10) }
        let configure = Task { try await store.configure(baseURL: base, token: "new-synthetic-readonly-token") }
        try await until { self.server.count("profiles") == 2 }
        store.forgetConnection()
        do { try await configure.value; XCTFail("Late configuration must not reconnect") }
        catch { XCTAssertEqual(error as? ReaderError, .cancelled) }
        XCTAssertFalse(store.configured)
        XCTAssertNil(store.overview)
        XCTAssertTrue(savedTokens.isEmpty)
    }
    func testCurrencyChangeClearsOldAmountsBeforeNewRequest() async {
        let store = makeStore(); await store.refreshIfNeeded()
        await store.loadReport(); await store.loadHoldings()
        XCTAssertNotNil(store.report); XCTAssertFalse(store.holdings.isEmpty)
        store.selectedCurrency = "USD"
        XCTAssertNil(store.report); XCTAssertTrue(store.holdings.isEmpty)
        XCTAssertEqual(store.holdingTotal, 0)
    }
    func testAutomaticRefreshUpdatesHoldingsReportAndAlchemy() async {
        let store = makeStore(); await store.refreshIfNeeded()
        for (tab, resource) in [(ReaderTab.holdings, "holdings"), (.profit, "report"), (.alchemy, "alchemy")] {
            store.selectedTab = tab
            await store.loadVisibleModule()
            let before = server.count(resource)
            now.addTimeInterval(61)
            await store.refreshIfNeeded()
            XCTAssertEqual(server.count(resource), before + 1, resource)
        }
    }
    func testCancelledRequestDoesNotLeaveModuleLoading() async throws {
        let store = makeStore(); await store.refreshIfNeeded()
        server.reply = { request in .init(data: try Self.fixture(request), delay: 0.1) }
        let pending = Task { await store.loadReport() }
        try await until { store.reportLoading }
        pending.cancel(); await pending.value
        XCTAssertFalse(store.reportLoading)
        XCTAssertNil(store.reportError)
        await store.loadReport()
        XCTAssertNotNil(store.report)
    }
    func testLockedKeychainRecoversWhenForegroundCanReadIt() async {
        var locked = true
        defaults.set("account-2", forKey: "reader.selectedProfile")
        let store = ReaderStore(defaults: defaults, credentials: .init(read: {
            if locked { throw KeychainError.unavailable }
            return "synthetic-test-readonly-token"
        }, save: { _ in }, remove: {}), makeClient: { configuration in
            let session = URLSessionConfiguration.ephemeral; session.protocolClasses = [StubProtocol.self]
            return APIClient(configuration: configuration, sessionConfiguration: session)
        })
        XCTAssertFalse(store.configured)
        locked = false
        await store.refreshIfNeeded()
        XCTAssertTrue(store.configured)
        XCTAssertEqual(store.overview?.profile.id, "account-2")
        XCTAssertNil(store.connectionMessage)
    }
    func testAlchemyNewSnapshotDuringPaginationRestartsAtFirstPage() async throws {
        let store = makeStore(); await store.refreshIfNeeded()
        server.reply = { request in
            guard request.url!.lastPathComponent == "alchemy" else { return .init(data: try Self.fixture(request)) }
            let page = Int(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "page" }!.value!)!
            let version = self.server.count("alchemy") == 1 ? "old" : "new"
            var envelope = try JSONSerialization.jsonObject(with: Self.fixture(request, version: version)) as! [String: Any]
            var result = envelope["result"] as! [String: Any]
            var row = (result["rows"] as! [[String: Any]])[0]
            row["id"] = "\(version)-\(page)"
            result["rows"] = [row]; result["total"] = 2; result["page"] = page
            envelope["result"] = result
            return .init(data: try JSONSerialization.data(withJSONObject: envelope))
        }
        await store.loadAlchemy()
        XCTAssertTrue(store.alchemyHasMore)
        await store.loadAlchemy(reset: false)
        XCTAssertEqual(store.alchemy?.page, 1)
        XCTAssertEqual(store.alchemy?.snapshotVersion, "new")
        XCTAssertEqual(store.alchemyRows.map(\.id), ["new-1"])
        XCTAssertFalse(store.alchemyLoading)
    }
    func testAutomaticCheckPreservesLoadedPagesUntilUserRefreshes() async throws {
        let store = makeStore(); store.selectedTab = .orders
        var newerSnapshot = false
        server.reply = { request in
            var envelope = try JSONSerialization.jsonObject(with: Self.fixture(request)) as! [String: Any]
            var result = envelope["result"] as! [String: Any]
            if request.url!.lastPathComponent == "overview", newerSnapshot {
                var profile = result["profile"] as! [String: Any]
                profile["uploadedAt"] = "2026-10-28T12:00:00Z"; result["profile"] = profile
            }
            if request.url!.lastPathComponent == "orders" {
                let page = Int(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "page" }!.value!)!
                var rows = result["rows"] as! [[String: Any]]
                for i in rows.indices { rows[i]["id"] = "page-\(page)-\(i)" }
                result["rows"] = rows; result["page"] = page; result["total"] = 60
            }
            envelope["result"] = result
            return .init(data: try JSONSerialization.data(withJSONObject: envelope))
        }
        await store.refreshIfNeeded()
        await store.loadOrders(reset: false)
        let ids = store.orders.map(\.id), reads = server.count("orders")
        newerSnapshot = true; now.addTimeInterval(61)
        await store.refreshIfNeeded()
        XCTAssertEqual(store.orders.map(\.id), ids)
        XCTAssertEqual(server.count("orders"), reads)
        XCTAssertTrue(store.pendingRefreshTabs.contains(.orders))
        await store.reloadProfiles()
        XCTAssertEqual(server.count("orders"), reads + 1)
        XCTAssertFalse(store.pendingRefreshTabs.contains(.orders))
        XCTAssertTrue(store.orders.allSatisfy { $0.id.hasPrefix("page-1") })
    }
}
