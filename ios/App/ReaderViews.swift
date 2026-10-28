import SwiftUI
import Charts
import UniformTypeIdentifiers
import BuffReaderCore

struct ReaderRootView: View {
    @EnvironmentObject private var store: ReaderStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var launching = true
    var body: some View {
        ZStack {
            Group {
                if store.configured {
                    TabView(selection: $store.selectedTab) {
                        OverviewView().tabItem { Label("概览", systemImage: "square.grid.2x2") }.tag(ReaderTab.overview)
                        HoldingsView().tabItem { Label("持仓", systemImage: "square.stack.3d.up") }.tag(ReaderTab.holdings)
                        OrdersView().tabItem { Label("订单", systemImage: "list.bullet.rectangle") }.tag(ReaderTab.orders)
                        NavigationStack { AlchemyView() }.tabItem { Label("炼金", systemImage: "flask") }.tag(ReaderTab.alchemy)
                        ProfitView().tabItem { Label("收益", systemImage: "chart.xyaxis.line") }.tag(ReaderTab.profit)
                    }.id(store.selectionRevision)
                } else { SettingsView(welcome: true) }
            }
            if launching { ReaderLaunchView().transition(.opacity).zIndex(1) }
        }
        .task {
            do { try await Task.sleep(for: .milliseconds(reduceMotion ? 180 : 700)) } catch { }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { launching = false }
        }
        .task(id: store.visibleRequestKey) {
            // A short debounce keeps text search responsive without firing for every keystroke.
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            await store.loadVisibleModule()
        }
        .sheet(isPresented: $store.showSettings) { SettingsView().presentationDragIndicator(.visible) }
    }
}

struct AccountMenu: View {
    @EnvironmentObject private var store: ReaderStore
    var body: some View {
        Menu {
            ForEach(store.profiles) { profile in
                Button { store.selectProfile(profile.id) } label: {
                    if profile.id == store.selectedProfileID { Label(profile.name, systemImage: "checkmark") }
                    else { Text(profile.name) }
                }
            }
        } label: {
            Text(store.selectedProfile?.name ?? "选择账户")
                .font(.subheadline.weight(.medium)).lineLimit(1)
        }
        .labelStyle(.titleAndIcon)
        .disabled(store.profiles.isEmpty)
        .accessibilityLabel("切换账户，当前为" + (store.selectedProfile?.name ?? "未选择"))
    }
}

struct CurrencyMenu: View {
    @EnvironmentObject private var store: ReaderStore
    var body: some View {
        if store.currencies.count > 1 {
            Picker("币种", selection: $store.selectedCurrency) {
                ForEach(store.currencies, id: \.self) { Text($0).tag($0) }
            }.pickerStyle(.menu).font(.caption.weight(.semibold))
        } else { Text(store.selectedCurrency).font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
    }
}

struct FreshnessView: View {
    @EnvironmentObject private var store: ReaderStore
    var body: some View {
        HStack(spacing: 8) {
            if store.refreshing || store.accountLoading { ProgressView().controlSize(.mini) }
            else { Image(systemName: store.accountError == nil && store.connectionMessage == nil ? "checkmark.icloud" : "icloud.slash") }
            VStack(alignment: .leading, spacing: 3) {
                Text(store.selectedProfile?.name ?? "当前账户").fontWeight(.medium).foregroundStyle(.primary)
                Text(store.refreshing || store.accountLoading ? "正在更新当前账户…" : "云端更新 " + DisplayFormat.date(store.selectedProfile?.uploadedAt))
                if store.accountError != nil || store.connectionMessage != nil { Text("更新未成功，当前显示上次读取的记录") }
            }
            Spacer(minLength: 0)
        }.font(.caption).foregroundStyle(.secondary).accessibilityElement(children: .combine)
    }
}

struct AccountRefreshIssue: View {
    @EnvironmentObject private var store: ReaderStore
    var body: some View {
        if let message = store.connectionMessage ?? store.accountError {
            InlineIssue(message: message) { Task { await store.reloadProfiles() } }
        }
        if store.pendingRefreshTabs.contains(store.selectedTab) {
            Button { Task { await store.reloadProfiles() } } label: {
                Label("云端有新数据，轻点更新列表", systemImage: "arrow.clockwise")
                    .font(.subheadline).frame(maxWidth: .infinity).padding(14)
            }.buttonStyle(.plain).readerGlassControl()
        }
    }
}

struct OverviewView: View {
    @EnvironmentObject private var store: ReaderStore
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        NavigationStack {
            ReaderScroll {
                FreshnessView()
                if let message = store.connectionMessage ?? store.accountError {
                    InlineIssue(message: message) { Task { await store.reloadProfiles() } }
                }
                ReaderCard(accent: true) {
                    if store.accountLoading && store.overview == nil { ReaderLoading(title: "正在读取账户概览…") }
                    else {
                        ProfitHero(cents: store.currencyOverview?.profitCents, known: store.currencyOverview?.knownProfitCents, currency: store.selectedCurrency)
                        Divider()
                        MetricRow(title: "现金买入成本", cents: store.currencyOverview?.cashInvestmentCents,
                                  known: store.currencyOverview?.knownCashInvestmentCents, currency: store.selectedCurrency)
                    }
                    Button { store.selectedTab = .profit } label: {
                        HStack { Text("查看收益报告"); Spacer(); Image(systemName: "arrow.up.right") }.font(.subheadline.weight(.medium))
                    }.buttonStyle(.plain).foregroundStyle(ReaderStyle.accent).padding(.vertical, 5)
                }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: typeSize.isAccessibilitySize ? 1 : 2), spacing: 14) {
                    overviewTile("当前持仓", value: store.currencyOverview?.holdingQuantity.map { "\($0)" } ?? "—", unit: "件", symbol: "square.stack.3d.up", tab: .holdings)
                    overviewTile("归档订单", value: store.selectedProfile.map { "\($0.recordCount)" } ?? "—", unit: "笔", symbol: "list.bullet.rectangle", tab: .orders)
                }
                AlchemyEntry()
                SectionHeading(title: "数据动态", subtitle: "三方记录，统一查阅")
                ReaderCard {
                    ForEach(["buff", "uu", "steam"], id: \.self) { platform in
                        PlatformSyncRow(platform: platform, profile: store.selectedProfile, sync: store.syncStatus, source: store.overview?.sourceStatus?[platform])
                        if platform != "steam" { Divider() }
                    }
                    NavigationLink { SyncDetailsView() } label: {
                        HStack { Text("账户关联与同步详情"); Spacer(); Image(systemName: "chevron.right").font(.caption) }.font(.subheadline)
                    }
                }
                if let quality = store.overview?.quality {
                    DisclosureGroup {
                        VStack(spacing: 14) {
                            LabeledContent("金额缺项", value: quality.unknownAmountCount.map(String.init) ?? "—")
                            LabeledContent("成交时间缺项", value: quality.missingTimeCount.map(String.init) ?? "—")
                            LabeledContent("名称待核对", value: quality.unresolvedNameCount.map(String.init) ?? "—")
                        }.font(.subheadline).padding(.top, 16)
                    } label: { Label("数据完整性", systemImage: "checkmark.shield").font(.subheadline.weight(.medium)) }
                    .padding(20).background(.thinMaterial, in: RoundedRectangle(cornerRadius: 22))
                }
                if store.selectedProfile?.state == "not-synced" {
                    ReaderEmpty(symbol: "icloud.and.arrow.up", title: "等待首次同步", message: "在对应电脑完成账号关联与首次上传后，这里会显示你的账本。")
                }
                ReaderNote(text: "已实现收益不含持仓、未提现余额与单纯净卖出；缺失金额保留待补全状态。")
            }
            .navigationTitle("饰品交易账本").readerToolbar()
            .refreshable { await store.reloadProfiles() }
        }
    }
    private func overviewTile(_ title: String, value: String, unit: String, symbol: String, tab: ReaderTab) -> some View {
        Button { store.selectedTab = tab } label: {
            ReaderCard {
                HStack { Image(systemName: symbol).foregroundStyle(ReaderStyle.accent); Spacer(); Image(systemName: "arrow.up.right").foregroundStyle(.tertiary) }
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(value).font(.system(.title, design: .rounded, weight: .semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
                    Text(unit).font(.caption).foregroundStyle(.secondary)
                }
                Text(title).font(.subheadline).foregroundStyle(.secondary)
            }
        }.buttonStyle(ReaderPressStyle()).accessibilityElement(children: .combine)
    }
}

struct PlatformSyncRow: View {
    let platform: String
    let profile: Profile?
    let sync: SyncStatusResponse?
    let source: SourceStatus?
    private var phase: String? {
        let status = sync?.status ?? profile?.status
        let entry = status?["platforms"]?[platform] ?? status?[platform]
        return entry?["phase"]?.string ?? entry?["status"]?.string
    }
    private var loginRequired: Bool { ["login-required", "expired", "unauthorized", "reauth-required"].contains(phase ?? "") }
    private var message: String {
        if loginRequired { return "登录失效，请在电脑重新认证" }
        if (profile?.bindings[platform] ?? nil) == nil { return "尚未关联" }
        if phase == "failed" || phase == "error" { return "同步未成功，历史仍可查看" }
        return "同步于 " + DisplayFormat.date(sync?.sourceStatus?[platform]?.lastSyncedAt ?? source?.lastSyncedAt)
    }
    var body: some View {
        HStack(spacing: 12) {
            PlatformMark(platform: platform)
            VStack(alignment: .leading, spacing: 5) {
                Text(DisplayFormat.platform(platform)).font(.subheadline.weight(.semibold))
                Text(message).font(.caption).foregroundStyle(loginRequired ? .orange : .secondary)
            }
            Spacer(minLength: 0)
            if let count = sync?.sourceStatus?[platform]?.recordCount ?? source?.recordCount {
                Text("\(count) 笔").font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
        }.accessibilityElement(children: .combine)
    }
}

struct SyncDetailsView: View {
    @EnvironmentObject private var store: ReaderStore
    var body: some View {
        List {
            Section("当前账户") {
                LabeledContent("账户", value: store.selectedProfile?.name ?? "—")
                LabeledContent("云端接收", value: DisplayFormat.date(store.syncStatus?.uploadedAt ?? store.selectedProfile?.uploadedAt))
                LabeledContent("数据采集", value: DisplayFormat.date(store.syncStatus?.collectedAt ?? store.selectedProfile?.collectedAt))
                Text("前台每分钟检查云端；返回 App 时按需更新。").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(["buff", "uu", "steam"], id: \.self) { platform in
                Section(DisplayFormat.platform(platform)) {
                    LabeledContent("关联账号", value: (store.selectedProfile?.bindings[platform] ?? nil) ?? "尚未关联").font(.subheadline).textSelection(.enabled)
                    PlatformSyncRow(platform: platform, profile: store.selectedProfile, sync: store.syncStatus, source: store.overview?.sourceStatus?[platform])
                }
            }
            Section {
                Text("电脑助手每 6 小时同步一次。电脑休眠、退出助手或平台登录失效时，新订单会延后更新。手机只读取已经上传的记录。")
                Text("账户关联由对应电脑管理；两组账户独立计算，不合并成本或收益。")
            }.font(.subheadline).foregroundStyle(.secondary)
        }.readerList().navigationTitle("同步详情").navigationBarTitleDisplayMode(.inline)
            .refreshable { await store.reloadProfiles() }
    }
}

struct OrdersView: View {
    @EnvironmentObject private var store: ReaderStore
    var body: some View {
        NavigationStack {
            ReaderScroll {
                if store.ordersError == nil { AccountRefreshIssue() }
                HStack {
                    Picker("平台", selection: $store.orderPlatform) {
                        Text("全部平台").tag("all"); Text("BUFF").tag("buff"); Text("悠悠").tag("uu"); Text("Steam").tag("steam")
                    }.pickerStyle(.menu).padding(.horizontal, 8).frame(minHeight: 44).readerGlassControl()
                    Spacer()
                    Text("\(store.orderTotal) 笔记录").font(.caption).foregroundStyle(.secondary)
                }
                Picker("方向", selection: $store.orderDirection) {
                    Text("全部").tag("all"); Text("买入").tag("buy"); Text("卖出").tag("sell")
                }.pickerStyle(.segmented)
                if let error = store.ordersError { InlineIssue(message: error) { Task { await store.loadOrders() } } }
                ForEach(store.orders) { row in
                    NavigationLink { OrderDetailView(row: row, revision: store.selectionRevision) } label: { OrderCard(row: row) }.buttonStyle(ReaderPressStyle())
                }
                if store.ordersLoading { ReaderLoading(title: "正在读取订单…") }
                else if store.orders.isEmpty && store.ordersError == nil { ReaderEmpty(symbol: "doc.text.magnifyingglass", title: "暂无匹配订单", message: "试试其他平台、方向或物品名称。") }
                else if store.orderHasMore { Button("加载更多订单") { Task { await store.loadOrders(reset: false) } }.buttonStyle(.bordered).frame(maxWidth: .infinity) }
            }
            .navigationTitle("订单").readerToolbar()
            .searchable(text: $store.orderSearch, prompt: "搜索物品名称")
            .refreshable { await store.reloadProfiles() }
        }
    }
}

private struct OrderCard: View {
    let row: OrderRow
    var body: some View {
        ReaderCard {
            HStack {
                ReaderBadge(title: row.direction == "buy" ? "买入" : "卖出", color: row.direction == "buy" ? .blue : .teal, symbol: row.direction == "buy" ? "arrow.down.left" : "arrow.up.right")
                Text(DisplayFormat.platform(row.platform)).font(.caption).foregroundStyle(.secondary)
                Spacer()
                if !row.completed { ReaderBadge(title: "待完成", color: .orange) }
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            Text(row.name).font(.headline).fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.direction == "buy" ? "实际支出" : "实际净到账").font(.caption).foregroundStyle(.secondary)
                    Text(DisplayFormat.money(row.actualTotalCents, currency: row.currencyCode ?? "")).font(.system(.title3, design: .rounded, weight: .semibold)).monospacedDigit()
                }
                Spacer()
                Text(row.quantity.map { "\($0) 件" } ?? "数量待补全").font(.subheadline).foregroundStyle(.secondary)
            }
            Text(row.tradedAt == nil ? "成交时间待补全" : DisplayFormat.date(row.tradedAt, includeYear: true)).font(.caption).foregroundStyle(.secondary)
        }.accessibilityElement(children: .combine)
    }
}

private struct OrderDetailView: View {
    @EnvironmentObject private var store: ReaderStore
    let row: OrderRow
    let revision: UUID
    var body: some View {
        List {
            if revision != store.selectionRevision { Text("账户已切换，请返回订单列表。") }
            else {
                Section { Text(row.name).font(.headline); if let name = row.marketHashName, name != row.name { Text(name).font(.subheadline).foregroundStyle(.secondary) } }
                Section("订单信息") {
                    LabeledContent("平台", value: DisplayFormat.platform(row.platform))
                    LabeledContent("方向", value: row.direction == "buy" ? "买入" : "卖出")
                    LabeledContent("数量", value: row.quantity.map(String.init) ?? "待补全")
                    LabeledContent(row.direction == "buy" ? "实际支出" : "实际净到账", value: DisplayFormat.money(row.actualTotalCents, currency: row.currencyCode ?? ""))
                    LabeledContent("币种", value: row.currencyCode.flatMap { $0.isEmpty ? nil : $0 } ?? "待确认")
                    LabeledContent("成交时间", value: row.tradedAt == nil ? "待补全" : DisplayFormat.date(row.tradedAt, includeYear: true))
                    LabeledContent("完成状态", value: row.completed ? "已完成" : "未完成或待核对")
                }
                Section("来源身份") { LabeledContent("平台账号", value: row.accountId); LabeledContent("订单号", value: row.orderId ?? "—") }.font(.subheadline).textSelection(.enabled)
            }
        }.readerList().navigationTitle("订单详情").navigationBarTitleDisplayMode(.inline)
    }
}

struct HoldingsView: View {
    @EnvironmentObject private var store: ReaderStore
    var body: some View {
        NavigationStack {
            ReaderScroll {
                if store.holdingsError == nil { AccountRefreshIssue() }
                ReaderCard(accent: true) {
                    HStack { SectionHeading(title: "你的持仓", subtitle: "按完整物品名称归组"); Spacer(); CurrencyMenu() }
                    HStack(alignment: .firstTextBaseline) {
                        Text(store.currencyOverview?.holdingQuantity.map(String.init) ?? "—").font(.system(.largeTitle, design: .rounded, weight: .semibold)).monospacedDigit()
                        Text("件").foregroundStyle(.secondary)
                        Spacer()
                        Text("\(store.holdingTotal) 个名称组").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                ReaderNote(text: "持仓由买卖订单推算，尚未扣除炼金消耗；不代表平台实时库存。")
                if let error = store.holdingsError { InlineIssue(message: error) { Task { await store.loadHoldings() } } }
                ForEach(store.holdings) { row in
                    ReaderCard {
                        HStack(alignment: .top, spacing: 12) {
                            ReaderIcon(symbol: "cube.transparent", color: .teal)
                            Text(row.name).font(.headline).frame(maxWidth: .infinity, alignment: .leading)
                            Text("\(row.quantity) 件").font(.subheadline.weight(.semibold)).monospacedDigit()
                        }
                        if (row.cashQuantity ?? 0) > 0 {
                            MetricRow(title: "现金来源 · \(row.cashQuantity ?? 0) 件", cents: row.cashCostCents, currency: row.currencyCode ?? store.selectedCurrency)
                        }
                        if (row.steamQuantity ?? 0) > 0 {
                            MetricRow(title: "Steam 面值 · \(row.steamQuantity ?? 0) 件", cents: row.steamFaceCents, currency: row.currencyCode ?? store.selectedCurrency)
                        }
                    }
                }
                if store.holdingsLoading { ReaderLoading(title: "正在读取持仓…") }
                else if store.holdings.isEmpty && store.holdingsError == nil { ReaderEmpty(symbol: "shippingbox", title: "暂无匹配持仓", message: "当前账户和筛选条件下没有持仓记录。") }
                else if store.holdingHasMore { Button("加载更多持仓") { Task { await store.loadHoldings(reset: false) } }.buttonStyle(.bordered).frame(maxWidth: .infinity) }
            }
            .navigationTitle("持仓").readerToolbar()
            .searchable(text: $store.holdingSearch, prompt: "搜索物品名称")
            .refreshable { await store.reloadProfiles() }
        }
    }
}

struct ProfitView: View {
    @EnvironmentObject private var store: ReaderStore
    var body: some View {
        NavigationStack {
            ReaderScroll {
                if store.reportError == nil { AccountRefreshIssue() }
                if let error = store.reportError { InlineIssue(message: error) { Task { await store.loadReport() } } }
                ReaderCard(accent: true) {
                    ProfitHero(cents: store.report?.summary.profitCents, known: store.report?.summary.knownProfitCents, currency: store.selectedCurrency)
                    Divider()
                    MetricRow(title: "现金买入成本", cents: store.report?.summary.cashInvestmentCents, known: store.report?.summary.knownCashInvestmentCents, currency: store.selectedCurrency)
                }
                if store.reportLoading { ReaderLoading(title: "正在读取收益…") }
                if let report = store.report {
                    if !chartPoints.isEmpty {
                        ReaderCard {
                            SectionHeading(title: "收益曲线", subtitle: "累计已实现收益 · \(report.currency)")
                            Chart(chartPoints) { point in
                                LineMark(x: .value("日期", point.row.date), y: .value("累计收益", Double(point.row.cumulativeProfitCents ?? 0) / 100), series: .value("连续已知区间", point.segment))
                                    .foregroundStyle(ReaderStyle.accent).lineStyle(StrokeStyle(lineWidth: 2.5))
                                PointMark(x: .value("日期", point.row.date), y: .value("累计收益", Double(point.row.cumulativeProfitCents ?? 0) / 100))
                                    .foregroundStyle(ReaderStyle.accent).symbolSize(12)
                            }.frame(height: 200).chartXAxis(.hidden).chartXScale(domain: report.daily.map(\.date))
                            HStack { Text(report.daily.first?.date ?? ""); Spacer(); Text(report.daily.last?.date ?? "") }.font(.caption2).foregroundStyle(.secondary)
                            if chartPoints.count < report.daily.count { Text("缺少依据的日期保留断点，不按零收益绘制。").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    SectionHeading(title: "每日收益", subtitle: "北京时间 · 最新在前")
                    ReaderCard {
                        ForEach(report.daily.reversed()) { row in
                            MetricRow(title: row.date, cents: row.profitCents, known: row.knownProfitCents, currency: report.currency)
                            if row.id != report.daily.first?.id { Divider() }
                        }
                        if report.daily.isEmpty { ReaderEmpty(symbol: "chart.xyaxis.line", title: "还没有已实现收益", message: "完成并上传可核算的交易后，收益会在这里展示。") }
                    }
                    if let note = report.scopeNote { ReaderNote(text: note) }
                }
                ReaderNote(text: "炼金收益在“炼金”中独立展示，不与本报告相加。")
            }
            .navigationTitle("收益").readerToolbar()
            .refreshable { await store.reloadProfiles() }
        }
    }
    private struct ChartPoint: Identifiable {
        let row: DailyProfit
        let segment: Int
        var id: String { row.id }
    }
    private var chartPoints: [ChartPoint] {
        var segment = 0
        return (store.report?.daily ?? []).compactMap { row in
            guard row.cumulativePending == 0, row.cumulativeProfitCents != nil else { segment += 1; return nil }
            return ChartPoint(row: row, segment: segment)
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: ReaderStore
    @Environment(\.dismiss) private var dismiss
    var welcome = false
    @State private var showImporter = false
    @State private var showManual = false
    @State private var endpoint = ClientConfiguration.defaultBaseURL
    @State private var accessCode = ""
    @State private var saving = false
    @State private var error: String?
    @State private var confirmForget = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 16) {
                        Image("BrandMark").resizable().scaledToFit().frame(width: 96, height: 96)
                        Text(welcome ? "你的账本，随身而行" : "连接你的账本").font(.title2.bold())
                        Text(welcome ? "一次连接，随时查阅订单、持仓、收益与真实炼金记录。" : "两组账户独立保存，手机随时查阅。")
                            .font(.subheadline).foregroundStyle(.secondary)
                        if welcome {
                            Button { showImporter = true } label: { Label("导入连接文件", systemImage: "square.and.arrow.down").frame(maxWidth: .infinity).padding(.vertical, 8) }
                                .buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                        }
                    }.padding(.vertical, 14)
                }
                Section("手机连接") {
                    LabeledContent("状态", value: store.configured ? "已连接" : "等待连接")
                    Text(store.baseURL).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    if !welcome { Button { showImporter = true } label: { Label("更新连接文件", systemImage: "square.and.arrow.down") } }
                    if store.configured {
                        Button { Task { await store.reloadProfiles() } } label: {
                            HStack { Text("刷新并检查连接"); Spacer(); if store.refreshing { ProgressView() } }
                        }.disabled(store.refreshing)
                        if let checkedAt = store.lastRefreshedAt {
                            LabeledContent("最近读取", value: checkedAt.formatted(date: .omitted, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if let message = error ?? store.connectionMessage ?? store.accountError { Section { InlineIssue(message: message) } }
                if store.configured {
                    Section {
                        ForEach(store.profiles) { profile in
                            Button { store.selectProfile(profile.id) } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: profile.id == store.selectedProfileID ? "checkmark.circle.fill" : "circle").foregroundStyle(profile.id == store.selectedProfileID ? ReaderStyle.accent : .secondary)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(profile.name).foregroundStyle(.primary)
                                        Text("\(profile.recordCount) 笔订单").font(.caption).foregroundStyle(.secondary)
                                    }
                                }.padding(.vertical, 4)
                            }
                        }
                    } header: { Text("账户") } footer: { Text("启动保留上次选择；切换账户后独立读取，自动清除上一账户的页面。") }
                }
                Section {
                    DisclosureGroup("手动配置", isExpanded: $showManual) {
                        TextField("HTTPS 服务地址", text: $endpoint).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        SecureField("手机只读访问码", text: $accessCode).textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button(saving ? "正在验证…" : "保存并连接") {
                            saving = true; error = nil
                            Task {
                                do { try await store.configure(baseURL: endpoint, token: accessCode); accessCode = ""; showManual = false }
                                catch { self.error = error.localizedDescription }
                                saving = false
                            }
                        }.disabled(saving || accessCode.isEmpty)
                    }
                } footer: { Text("只读访问码保存在手机钥匙串。平台登录与采集由电脑助手完成。") }
                Section("关于") {
                    LabeledContent("应用", value: "饰品交易账本")
                    LabeledContent("版本", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.2.0")
                    Text("前台每分钟检查云端新数据；电脑每 6 小时同步平台记录。手机不执行购买、出售或交易确认。").font(.caption).foregroundStyle(.secondary)
                }
                if store.configured { Section { Button("清除手机连接", role: .destructive) { confirmForget = true } } }
            }.readerList()
            .navigationTitle(welcome ? "欢迎使用" : "连接与设置")
            .toolbar { if !welcome { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } } }
            .onAppear { endpoint = store.baseURL }
            .fileImporter(isPresented: $showImporter, allowedContentTypes: [.json, UTType(importedAs: "com.buffhelper.connection")]) { result in
                switch result {
                case .success(let url): Task { await store.importConnection(url) }
                case .failure: error = "连接文件未能打开，请重试。"
                }
            }
            .confirmationDialog("清除这台手机的连接？", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("清除连接", role: .destructive) { store.forgetConnection(); dismiss() }
            } message: { Text("云端和电脑中的订单保持不变。再次导入连接文件即可恢复查阅。") }
        }
    }
}
