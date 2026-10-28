import SwiftUI
import BuffReaderCore

struct AlchemyEntry: View {
    @EnvironmentObject private var store: ReaderStore
    var body: some View {
        Button { store.selectedTab = .alchemy } label: {
            ReaderCard {
                HStack(spacing: 14) {
                    ReaderIcon(symbol: "flask", color: .indigo)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("已完成炼金").font(.headline)
                        Text("真实配方，追溯每一份投入").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.right").font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }.buttonStyle(ReaderPressStyle())
    }
}

struct AlchemyView: View {
    @EnvironmentObject private var store: ReaderStore
    @State private var showDates = false
    var body: some View {
        ReaderScroll {
            if store.alchemyError == nil { AccountRefreshIssue() }
            HStack {
                Button { showDates = true } label: {
                    Label(store.alchemyFrom.isEmpty && store.alchemyTo.isEmpty ? "全部日期" : "已筛选日期", systemImage: "calendar")
                        .font(.subheadline.weight(.medium)).padding(.horizontal, 16).frame(minHeight: 44)
                }.buttonStyle(.plain).readerGlassControl()
                Spacer()
                Text("实际合成记录").font(.caption).foregroundStyle(.secondary)
            }
            if !store.alchemyFrom.isEmpty || !store.alchemyTo.isEmpty {
                Text("\(store.alchemyFrom) — \(store.alchemyTo) · 北京时间").font(.caption).foregroundStyle(.secondary)
            }
            if let message = store.alchemyError { InlineIssue(message: message) { Task { await store.loadAlchemy() } } }
            if let data = store.alchemy {
                ReaderCard(accent: true) {
                    HStack {
                        SectionHeading(title: "已完成炼金", subtitle: "当前筛选范围内的全部记录")
                        Spacer(); Image(systemName: "flask").font(.title2).foregroundStyle(.indigo)
                    }
                    HStack(alignment: .firstTextBaseline) {
                        Text("\(data.summary.craftCount)").font(.system(.largeTitle, design: .rounded, weight: .semibold)).monospacedDigit()
                        Text("次合成").font(.subheadline).foregroundStyle(.secondary)
                        Spacer()
                        Text("\(data.summary.soldCount) 次已出售").font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(data.summary.currencies) { summary in
                        Divider()
                        if summary.cashCount > 0 {
                            MetricRow(title: "现金收益 · \(summary.currencyCode)", cents: summary.cashProfitCents, currency: summary.currencyCode)
                        } else { LabeledContent("现金收益 · \(summary.currencyCode)", value: "暂无已核对出售").font(.subheadline) }
                        Text("已核对 \(summary.cashCount) 次现金出售").font(.caption).foregroundStyle(.secondary)
                        if summary.steamCount > 0 {
                            MetricRow(title: "Steam 余额盈亏", cents: summary.steamProfitCents, currency: summary.currencyCode)
                        } else { LabeledContent("Steam 余额盈亏", value: "暂无已核对出售").font(.subheadline) }
                        Text("已核对 \(summary.steamCount) 次纯余额买卖").font(.caption).foregroundStyle(.secondary)
                    }
                    if data.summary.pendingCount > 0 { ReaderBadge(title: "\(data.summary.pendingCount) 次待核对", color: .orange, symbol: "clock") }
                }
            }
            ReaderNote(text: "现金收益与 Steam 余额盈亏分开核算，独立于交易收益报告。")
            SectionHeading(title: "合成记录", subtitle: "投入 → 产出 → 实际去向")
            ForEach(store.alchemyRows) { row in
                NavigationLink { AlchemyDetailView(row: row, revision: store.selectionRevision, snapshotVersion: store.alchemy?.snapshotVersion) } label: {
                    ReaderCard {
                        HStack {
                            ReaderBadge(title: row.stateLabel, color: row.state == "sold" ? .teal : .secondary)
                            Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                        Text(row.output.name).font(.headline)
                        HStack(spacing: 8) {
                            Image(systemName: "square.stack.3d.up")
                            Text("\(row.inputs.reduce(0) { $0 + $1.quantity }) 件投入")
                            Image(systemName: "arrow.right").font(.caption)
                            Text("1 件产出")
                        }.font(.caption).foregroundStyle(.secondary)
                        Divider()
                        VStack(alignment: .leading, spacing: 7) {
                            Text(row.profitLabel).font(.system(.title3, design: .rounded, weight: .semibold))
                                .foregroundStyle(ReaderStyle.profit(row.cashProfitCents ?? row.steamProfitCents)).monospacedDigit()
                            Text("投入 " + row.cost.description(currency: row.currencyCode)).font(.caption).foregroundStyle(.secondary)
                            Text(DisplayFormat.date(row.at, includeYear: true)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }.buttonStyle(ReaderPressStyle())
            }
            if store.alchemyLoading { ReaderLoading(title: "正在读取炼金记录…") }
            else if store.alchemyRows.isEmpty && store.alchemyError == nil {
                ReaderEmpty(symbol: "flask", title: "暂无已完成炼金", message: "调整筛选，或在电脑助手中同步真实库存历史。")
            } else if store.alchemyHasMore {
                Button("加载更多炼金记录") { Task { await store.loadAlchemy(reset: false) } }.buttonStyle(.bordered).frame(maxWidth: .infinity)
            }
            if let data = store.alchemy {
                ReaderCard {
                    DisclosureGroup {
                        VStack(alignment: .leading, spacing: 14) {
                            ForEach(data.archives) { archive in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(archive.complete ? "已读至平台末页 / 已知边界" : "历史尚未读完，请在电脑继续同步")
                                    Text("\(archive.eventCount) 条库存事件 · \(archive.craftCount) 次炼金")
                                    Text("库存同步 " + DisplayFormat.date(archive.syncedAt, includeYear: true))
                                }
                            }
                            if data.archives.isEmpty { Text("尚无库存历史，请在电脑助手同步。") }
                            Text("云端接收 " + DisplayFormat.date(data.uploadedAt, includeYear: true))
                        }.font(.caption).foregroundStyle(.secondary).padding(.top, 14)
                    } label: { Label("历史覆盖与同步", systemImage: "clock.arrow.circlepath").font(.subheadline.weight(.medium)) }
                }
                ReaderNote(text: data.scopeNote)
            }
        }
        .navigationTitle("炼金").readerToolbar()
        .searchable(text: $store.alchemySearch, prompt: "搜索产出或投入材料")
        .refreshable { await store.reloadProfiles() }
        .sheet(isPresented: $showDates) { AlchemyDateSheet().presentationDetents([.medium, .large]).presentationDragIndicator(.visible) }
    }
}

private struct AlchemyDateSheet: View {
    @EnvironmentObject private var store: ReaderStore
    @Environment(\.dismiss) private var dismiss
    @State private var from = Calendar.current.date(byAdding: .month, value: -1, to: Date()) ?? Date()
    @State private var to = Date()
    private var formatter: DateFormatter {
        let value = DateFormatter(); value.locale = Locale(identifier: "en_US_POSIX")
        value.calendar = Calendar(identifier: .gregorian); value.timeZone = TimeZone(identifier: "Asia/Shanghai"); value.dateFormat = "yyyy-MM-dd"
        return value
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("开始日期", selection: $from, in: ...to, displayedComponents: .date)
                    DatePicker("结束日期", selection: $to, in: from..., displayedComponents: .date)
                } footer: { Text("按北京时间的合成日期筛选；出售状态仍以最新云端记录为准。") }
                Section { Button("查看全部日期") { store.alchemyFrom = ""; store.alchemyTo = ""; dismiss() } }
            }.readerList().navigationTitle("合成日期").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("应用") { store.alchemyFrom = formatter.string(from: from); store.alchemyTo = formatter.string(from: to); dismiss() }
                    }
                }
                .onAppear { from = formatter.date(from: store.alchemyFrom) ?? from; to = formatter.date(from: store.alchemyTo) ?? to }
        }.environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
            .environment(\.calendar, Calendar(identifier: .gregorian))
    }
}

private struct AlchemyDetailView: View {
    @EnvironmentObject private var store: ReaderStore
    let row: AlchemyRow
    let revision: UUID
    let snapshotVersion: String?
    var body: some View {
        ReaderScroll {
            if store.selectedProfileID != row.profileId || revision != store.selectionRevision {
                ReaderEmpty(symbol: "person.crop.circle.badge.exclamationmark", title: "账户已切换", message: "请返回炼金列表，查看当前账户的记录。")
            } else if snapshotVersion != store.alchemy?.snapshotVersion {
                ReaderEmpty(symbol: "arrow.clockwise", title: "炼金记录已更新", message: "请返回列表，重新打开最新配方与出售状态。")
            } else {
                ReaderCard(accent: true) {
                    ReaderBadge(title: "实际产出", color: .indigo, symbol: "sparkles")
                    Text(row.output.name).font(.title2.bold())
                    if row.output.marketHashName != row.output.name { Text(row.output.marketHashName).font(.caption).foregroundStyle(.secondary) }
                    Text(DisplayFormat.date(row.at, includeYear: true)).font(.subheadline).foregroundStyle(.secondary)
                    ReaderBadge(title: row.stateLabel, color: row.state == "sold" ? .teal : .secondary)
                    Divider()
                    Text(row.profitLabel).font(.system(.title2, design: .rounded, weight: .semibold)).foregroundStyle(ReaderStyle.profit(row.cashProfitCents ?? row.steamProfitCents))
                    Text("投入 " + row.cost.description(currency: row.currencyCode)).font(.subheadline).foregroundStyle(.secondary)
                    MetricRow(title: "可追溯现金成本", cents: row.cost.basis, currency: row.currencyCode)
                }
                SectionHeading(title: "实际投入", subtitle: "\(row.inputs.reduce(0) { $0 + $1.quantity }) 件材料 · 按购买平均成本结转")
                ForEach(Array(row.inputs.enumerated()), id: \.offset) { index, material in
                    ReaderCard {
                        HStack {
                            ReaderBadge(title: String(format: "%02d", index + 1), color: .indigo)
                            Spacer(); Text("\(material.quantity) 件").font(.subheadline.weight(.semibold))
                        }
                        Text(material.name).font(.headline)
                        Text(material.cost.description(currency: row.currencyCode)).font(.subheadline)
                        if let reason = material.reason, !reason.isEmpty { ReaderNote(text: reason) }
                        if !material.parentCraftIds.isEmpty { ReaderNote(text: "成本由此前已完成炼金结转。") }
                        if !material.sources.isEmpty {
                            DisclosureGroup("平均成本来源 · \(material.sources.count) 笔买入") {
                                ForEach(material.sources) { source in
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(DisplayFormat.platform(source.platform) + " · " + DisplayFormat.date(source.tradedAt, includeYear: true))
                                        Text("\(source.quantity) 件 / " + DisplayFormat.money(source.totalCents, currency: source.currencyCode))
                                        Text("订单 " + (source.orderId ?? "CSV")).textSelection(.enabled)
                                    }.font(.caption).padding(.vertical, 8)
                                }
                            }.font(.subheadline)
                        }
                    }
                }
                if let sale = row.sale {
                    SectionHeading(title: "实际出售")
                    ReaderCard {
                        LabeledContent("平台", value: DisplayFormat.platform(sale.platform))
                        LabeledContent("时间", value: DisplayFormat.date(sale.tradedAt, includeYear: true))
                        MetricRow(title: "净到账", cents: sale.netCents, currency: sale.currencyCode)
                        LabeledContent("订单", value: sale.orderId ?? "CSV").textSelection(.enabled)
                    }.font(.subheadline)
                }
                if !row.reasons.isEmpty {
                    ReaderCard {
                        SectionHeading(title: "核对说明")
                        ForEach(Array(row.reasons.enumerated()), id: \.offset) { _, reason in ReaderNote(text: reason) }
                    }
                }
            }
        }.navigationTitle("炼金配方").navigationBarTitleDisplayMode(.inline)
    }
}
