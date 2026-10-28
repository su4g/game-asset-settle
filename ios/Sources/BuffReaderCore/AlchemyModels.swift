import Foundation

public struct AlchemyCost: Decodable, Sendable {
    public let cash: Int64?
    public let steam: Int64?
    public let basis: Int64?
    public func description(currency: String) -> String {
        guard !currency.isEmpty else { return "币种 / 成本待核对" }
        if cash == nil && steam == nil { return "成本待核对" }
        if cash == 0 { return DisplayFormat.money(steam, currency: currency) + " · Steam 余额" }
        if steam == 0 { return DisplayFormat.money(cash, currency: currency) + " · 现金" }
        return DisplayFormat.money(cash, currency: currency) + " 现金 + " + DisplayFormat.money(steam, currency: currency) + " Steam 余额"
    }
}
public struct AlchemyItem: Decodable, Sendable {
    public let name: String
    public let marketHashName: String
    public let quantity: Int
    public let collection: String
}
public struct AlchemySource: Decodable, Identifiable, Sendable {
    public let id: String
    public let platform: String
    public let orderId: String?
    public let tradedAt: String
    public let quantity: Int
    public let totalCents: Int64?
    public let currencyCode: String
}
public struct AlchemyIngredient: Decodable, Sendable {
    public let name: String
    public let marketHashName: String
    public let quantity: Int
    public let cost: AlchemyCost
    public let reason: String?
    public let parentCraftIds: [String]
    public let sources: [AlchemySource]
}
public struct AlchemySale: Decodable, Sendable {
    public let platform: String
    public let orderId: String?
    public let tradedAt: String
    public let currencyCode: String
    public let netCents: Int64?
}
public struct AlchemyRow: Decodable, Identifiable, Sendable {
    public let id: String
    public let profileId: String
    public let at: String
    public let output: AlchemyItem
    public let inputs: [AlchemyIngredient]
    public let currencyCode: String
    public let cost: AlchemyCost
    public let state: String
    public let complete: Bool
    public let cashProfitCents: Int64?
    public let steamProfitCents: Int64?
    public let sale: AlchemySale?
    public let reasons: [String]
    public var stateLabel: String {
        ["held": "尚无已确认出售", "sold": "已出售", "reused": "投入后续炼金", "removed": "库存消耗 / 移出", "ambiguous": "去向待核对", "cost-pending": "成本待核对", "proceeds-pending": "净到账待确认"][state] ?? "待核对"
    }
    public var profitLabel: String {
        if let cashProfitCents { return DisplayFormat.money(cashProfitCents, currency: currencyCode) + " · 现金" }
        if let steamProfitCents { return DisplayFormat.money(steamProfitCents, currency: currencyCode) + " · Steam 余额" }
        return sale == nil ? "尚未实现" : "收益待核对"
    }
}
public struct AlchemyCurrencySummary: Decodable, Identifiable, Sendable {
    public var id: String { currencyCode }
    public let currencyCode: String
    public let cashCount: Int
    public let steamCount: Int
    public let cashProfitCents: Int64?
    public let steamProfitCents: Int64?
}
public struct AlchemySummary: Decodable, Sendable {
    public let craftCount: Int
    public let soldCount: Int
    public let pendingCount: Int
    public let currencies: [AlchemyCurrencySummary]
}
public struct AlchemyArchive: Decodable, Identifiable, Sendable {
    public var id: String { accountId }
    public let accountId: String
    public let complete: Bool
    public let eventCount: Int
    public let craftCount: Int
    public let syncedAt: String?
}
public struct AlchemyResponse: Decodable, Sendable {
    public let profileId: String
    public let snapshotVersion: String
    public let uploadedAt: String?
    public let rows: [AlchemyRow]
    public let summary: AlchemySummary
    public let archives: [AlchemyArchive]
    public let total: Int
    public let page: Int
    public let pageSize: Int
    public let scopeNote: String
}
