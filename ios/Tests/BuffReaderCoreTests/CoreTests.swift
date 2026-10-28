import XCTest
@testable import BuffReaderCore

final class CoreTests: XCTestCase {
    let token = "test-readonly-token-123456789"
    func testPreservesReverseProxyPrefixAndReadOnlyMethod() throws {
        let config = try ClientConfiguration(baseURL: "https://www.example.com/buff-helper-api/", accessToken: token)
        let request = try config.request(resource: "orders", profileID: "account-2", query: [.init(name: "q", value: "印花 & 饰品")])
        XCTAssertEqual(request.url?.path, "/buff-helper-api/v1/profiles/account-2/orders")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + token)
        XCTAssertFalse(request.url!.absoluteString.contains(token))
        XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "印花 & 饰品")
    }
    func testRejectsUntrustedTransportAndEmbeddedCredentials() {
        for url in ["http://example.com", "https://user:password@example.com", "https://example.com?token=x", "https://example.com/#secret", "https://example.com:8443", "https://example.com/a/../b", "https://example.com/a%2Fb"] {
            XCTAssertThrowsError(try ClientConfiguration(baseURL: url, accessToken: token), url)
        }
    }
    func testCannotConstructTradingOrForeignPath() throws {
        let config = try ClientConfiguration(baseURL: "https://example.com/api", accessToken: token)
        XCTAssertThrowsError(try config.request(resource: "buy", profileID: "account-1"))
        XCTAssertThrowsError(try config.request(resource: "orders", profileID: "../account-2"))
        XCTAssertThrowsError(try config.request(resource: "orders", profileID: "https://other.example"))
    }
    func testRejectsHeaderInjection() {
        XCTAssertThrowsError(try ClientConfiguration(baseURL: "https://example.com", accessToken: "1234567890123456\r\nOther: value"))
        XCTAssertThrowsError(try ClientConfiguration(baseURL: "https://example.com", accessToken: "short"))
    }
    func testMissingAmountStaysUnknownAndIntegerCentsRemainExact() throws {
        let data = Data(#"{"currencyCode":"CNY","cashInvestmentCents":9007199254740991,"profitCents":null,"knownProfitCents":12,"holdingQuantity":0}"#.utf8)
        let row = try JSONDecoder().decode(CurrencyOverview.self, from: data)
        XCTAssertEqual(row.cashInvestmentCents, 9_007_199_254_740_991)
        XCTAssertNil(row.profitCents)
        XCTAssertEqual(row.knownProfitCents, 12)
        XCTAssertEqual(DisplayFormat.money(nil), "待补全")
        XCTAssertTrue(DisplayFormat.money(12).contains("0.12"))
        XCTAssertEqual(DisplayFormat.money(12, currency: ""), "0.12（币种待确认）")
    }
    func testStaleAccountResponseCannotMatchCurrentSelection() {
        let first = SelectionFence(profileID: "account-1")
        let second = SelectionFence(profileID: "account-2")
        let firstAgain = SelectionFence(profileID: "account-1")
        XCTAssertNotEqual(first, second)
        XCTAssertNotEqual(first, firstAgain)
    }
    func testConnectionFileVersionAndNoPlainHTTP() throws {
        XCTAssertThrowsError(try ConnectionFile(version: 2, baseURL: "https://example.com", accessToken: token).validated())
        XCTAssertThrowsError(try ConnectionFile(baseURL: "http://example.com", accessToken: token).validated())
        XCTAssertEqual(try ConnectionFile(baseURL: "https://example.com/buff-helper-api/", accessToken: token).validated().baseURL.path, "/buff-helper-api")
    }
    func testNotSyncedProfileDecodesWithoutInventingTimestamp() throws {
        let data = Data(#"{"profiles":[{"id":"account-2","name":"账户二","bindings":{"buff":null,"uu":null,"steam":null},"recordCount":0,"collectedAt":null,"uploadedAt":null,"state":"not-synced","status":{}}]}"#.utf8)
        let response = try JSONDecoder().decode(ProfilesResponse.self, from: data)
        XCTAssertEqual(response.profiles.first?.id, "account-2")
        XCTAssertNil(response.profiles.first?.uploadedAt)
        XCTAssertEqual(DisplayFormat.date(nil), "尚未同步")
    }
    func testCloudDTOConsumerContract() throws {
        func decode<T: Decodable>(_ name: String, _ type: T.Type) throws -> T {
            let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")!
            let json = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
            return try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: json["result"]!))
        }
        XCTAssertEqual(try decode("profiles", ProfilesResponse.self).profiles.count, 2)
        XCTAssertEqual(try decode("overview", OverviewResponse.self).currencies.first?.profitCents, 100)
        XCTAssertEqual(try decode("orders", OrdersResponse.self).rows.count, 2)
        XCTAssertEqual(try decode("holdings", HoldingsResponse.self).rows.first?.cashCostCents, 100)
        let report = try decode("report", ReportResponse.self)
        XCTAssertEqual(report.daily.count, 3)
        XCTAssertEqual(report.daily.last?.cumulativePending, 0)
        XCTAssertEqual(report.summary.profitCents, 100)
        XCTAssertEqual(try decode("sync-status", SyncStatusResponse.self).profileId, "account-1")
        let alchemy = try decode("alchemy", AlchemyResponse.self)
        XCTAssertEqual(alchemy.profileId, "account-1")
        XCTAssertEqual(alchemy.rows[0].inputs[0].quantity, 10)
        XCTAssertEqual(alchemy.rows[0].cost.cash, 1000)
        XCTAssertEqual(alchemy.rows[0].cashProfitCents, 500)
        XCTAssertNil(alchemy.rows[0].steamProfitCents)
        XCTAssertEqual(alchemy.archives[0].complete, true)
        XCTAssertEqual(alchemy.summary.currencies[0].cashCount, 1)
    }
    func testAlchemyCurrencyUnknownCostsAndBeijingDate() throws {
        let cost = try JSONDecoder().decode(AlchemyCost.self, from: Data(#"{"cash":0,"steam":6800,"basis":null}"#.utf8))
        XCTAssertNil(cost.basis)
        XCTAssertTrue(cost.description(currency: "CNY").contains("68.00"))
        XCTAssertTrue(cost.description(currency: "CNY").contains("Steam 余额"))
        let unknown = try JSONDecoder().decode(AlchemyCost.self, from: Data(#"{"cash":null,"steam":null,"basis":null}"#.utf8))
        XCTAssertEqual(unknown.description(currency: "CNY"), "成本待核对")
        XCTAssertEqual(cost.description(currency: ""), "币种 / 成本待核对")
        XCTAssertEqual(DisplayFormat.date("2026-10-27T16:05:00.000Z", includeYear: true), "2026-10-28 00:05")
        let request = try ClientConfiguration(baseURL: "https://example.com/buff-helper-api", accessToken: token).request(resource: "alchemy", profileID: "account-1")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/buff-helper-api/v1/profiles/account-1/alchemy")
    }
}
