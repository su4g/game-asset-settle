import Foundation

public enum JSONValue: Codable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { self = .array(try c.decode([JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    public subscript(_ key: String) -> JSONValue? { if case .object(let v) = self { return v[key] }; return nil }
    public var string: String? { if case .string(let v) = self { return v }; return nil }
    public var number: Double? { if case .number(let v) = self { return v }; return nil }
    public var bool: Bool? { if case .bool(let v) = self { return v }; return nil }
    public var object: [String: JSONValue]? { if case .object(let v) = self { return v }; return nil }
}

public struct Profile: Decodable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let bindings: [String: String?]
    public let recordCount: Int
    public let collectedAt: String?
    public let uploadedAt: String?
    public let state: String?
    public let status: JSONValue?
}
public struct ProfilesResponse: Decodable, Sendable { public let profiles: [Profile] }
public struct CurrencyOverview: Decodable, Identifiable, Sendable {
    public var id: String { currencyCode }
    public let currencyCode: String
    public let cashInvestmentCents: Int64?
    public let knownCashInvestmentCents: Int64?
    public let profitCents: Int64?
    public let knownProfitCents: Int64?
    public let holdingQuantity: Int?
    public let pendingQuantity: Int?
    public let netSaleQuantity: Int?
    public let historicalKnifeRatio: Double?
    public let cashoutRatio: Double?
}
public struct DataQuality: Decodable, Sendable {
    public let unknownAmountCount: Int?
    public let missingTimeCount: Int?
    public let unresolvedNameCount: Int?
}
public struct OverviewResponse: Decodable, Sendable {
    public let profile: Profile
    public let currencies: [CurrencyOverview]
    public let quality: DataQuality?
    public let sourceStatus: [String: SourceStatus]?
}
public struct SourceStatus: Decodable, Sendable {
    public let lastSyncedAt: String?
    public let recordCount: Int?
    public let accounts: [SourceAccount]?
}
public struct SourceAccount: Decodable, Sendable {
    public let accountId: String
    public let lastSyncedAt: String?
    public let runs: [JSONValue]?
}
public struct OrderRow: Decodable, Identifiable, Sendable {
    public let id: String
    public let platform: String
    public let accountId: String
    public let appid: Int?
    public let orderId: String?
    public let name: String
    public let marketHashName: String?
    public let direction: String
    public let currencyCode: String?
    public let quantity: Int?
    public let actualTotalCents: Int64?
    public let tradedAt: String?
    public let state: String?
    public let completed: Bool
}
public struct OrdersResponse: Decodable, Sendable {
    public let rows: [OrderRow]
    public let total: Int
    public let page: Int
    public let pageSize: Int
}
public struct HoldingRow: Decodable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let marketHashName: String?
    public let appid: Int?
    public let currencyCode: String?
    public let quantity: Int
    public let cashQuantity: Int?
    public let cashCostCents: Int64?
    public let steamQuantity: Int?
    public let steamFaceCents: Int64?
    public let excluded: Bool?
}
public struct HoldingsResponse: Decodable, Sendable {
    public let rows: [HoldingRow]
    public let total: Int
    public let page: Int
    public let pageSize: Int
    public let currency: String?
}
public struct ReportSummary: Decodable, Sendable {
    public let profitCents: Int64?
    public let knownProfitCents: Int64?
    public let cashInvestmentCents: Int64?
    public let knownCashInvestmentCents: Int64?
    public let holdingQuantity: Int?
    public let pendingQuantity: Int?
}
public struct DailyProfit: Decodable, Identifiable, Sendable {
    public var id: String { date }
    public let date: String
    public let profitCents: Int64?
    public let knownProfitCents: Int64?
    public let cumulativeProfitCents: Int64?
    public let cumulativePending: Int?
}
public struct ReportResponse: Decodable, Sendable {
    public let method: String?
    public let currency: String
    public let summary: ReportSummary
    public let daily: [DailyProfit]
    public let groups: [JSONValue]?
    public let total: Int?
    public let page: Int?
    public let pageSize: Int?
    public let scopeNote: String?
}
public struct SyncStatusResponse: Decodable, Sendable {
    public let profileId: String
    public let collectedAt: String?
    public let uploadedAt: String?
    public let status: JSONValue?
    public let sourceStatus: [String: SourceStatus]?
}

/// Every asynchronous result is tied to the selected account and connection generation.
public struct SelectionFence: Equatable, Sendable {
    public let profileID: String
    public let generation: UUID
    public init(profileID: String) { self.profileID = profileID; self.generation = UUID() }
}

public enum DisplayFormat {
    public static func money(_ cents: Int64?, currency: String = "CNY") -> String {
        guard let cents else { return "待补全" }
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.numberStyle = currency.isEmpty ? .decimal : .currency
        if !currency.isEmpty { formatter.currencyCode = currency }
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        let value = formatter.string(from: NSDecimalNumber(decimal: Decimal(cents) / 100)) ?? "—"
        return currency.isEmpty ? value + "（币种待确认）" : value
    }
    public static func platform(_ platform: String) -> String {
        ["buff": "BUFF", "uu": "悠悠", "steam": "Steam", "csv": "CSV"] [platform] ?? platform
    }
    public static func percent(_ ratio: Double?) -> String {
        guard let ratio, ratio.isFinite else { return "待补全" }
        return String(format: "%.2f%%", ratio * 100)
    }
    public static func date(_ raw: String?, relative: Bool = false, includeYear: Bool = false) -> String {
        guard let raw, !raw.isEmpty else { return "尚未同步" }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        guard let date else { return String(raw.prefix(10)) }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
        formatter.dateFormat = includeYear ? "yyyy-MM-dd HH:mm" : "MM-dd HH:mm"
        return formatter.string(from: date)
    }
}
