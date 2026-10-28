import SwiftUI
import BuffReaderCore

/// Content uses standard material. Liquid Glass is reserved for floating controls.
enum ReaderStyle {
    static let accent = Color.blue
    static let mint = Color.teal
    static let corner: CGFloat = 26
    static func profit(_ cents: Int64?) -> Color { cents.map { $0 < 0 ? .red : Color("ProfitPositive") } ?? .primary }
}

struct ReaderPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct ReaderBackdrop: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var opaque
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(uiColor: .systemGroupedBackground)
            if !opaque {
                Ellipse().fill(.blue.opacity(scheme == .dark ? 0.16 : 0.10))
                    .frame(width: 420, height: 320).blur(radius: 85).offset(x: -170, y: -100)
                Ellipse().fill(.teal.opacity(scheme == .dark ? 0.10 : 0.09))
                    .frame(width: 320, height: 420).blur(radius: 95).offset(x: 180, y: 130)
            }
        }.ignoresSafeArea().accessibilityHidden(true)
    }
}

struct ReaderCard<Content: View>: View {
    @Environment(\.accessibilityReduceTransparency) private var opaque
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.colorScheme) private var scheme
    var accent = false
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 18) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(22)
            .background {
                let shape = RoundedRectangle(cornerRadius: ReaderStyle.corner, style: .continuous)
                if opaque || contrast == .increased { shape.fill(Color(uiColor: .secondarySystemGroupedBackground)) }
                else { shape.fill(.regularMaterial) }
                if accent { shape.fill(LinearGradient(colors: [.blue.opacity(0.10), .teal.opacity(0.04), .clear], startPoint: .topLeading, endPoint: .bottomTrailing)) }
                shape.strokeBorder(scheme == .dark ? .white.opacity(0.10) : .white.opacity(0.75), lineWidth: 1)
            }
            .shadow(color: .black.opacity(scheme == .dark ? 0.07 : 0.025), radius: 18, x: 0, y: 8)
    }
}

struct ReaderScroll<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) { content }
                .frame(maxWidth: 700).frame(maxWidth: .infinity)
                .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 32)
        }.background { ReaderBackdrop() }
    }
}

struct SectionHeading: View {
    let title: String
    var subtitle: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.title3.bold())
            if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
        }.accessibilityElement(children: .combine)
    }
}

struct ReaderBadge: View {
    let title: String
    var color: Color = .secondary
    var symbol: String? = nil
    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol) }
            Text(title).foregroundStyle(.primary)
        }.font(.caption.weight(.medium)).foregroundStyle(color)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(color.opacity(0.09), in: Capsule())
            .accessibilityElement(children: .combine)
    }
}

struct ReaderIcon: View {
    let symbol: String
    var color: Color = ReaderStyle.accent
    var body: some View {
        Image(systemName: symbol).font(.system(size: 20, weight: .medium))
            .foregroundStyle(color).frame(width: 44, height: 44)
            .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
            .accessibilityHidden(true)
    }
}

struct MetricRow: View {
    let title: String
    let cents: Int64?
    var known: Int64? = nil
    let currency: String
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) { Text(title).foregroundStyle(.secondary); Spacer(minLength: 12); amount }
                VStack(alignment: .leading, spacing: 6) { Text(title).foregroundStyle(.secondary); amount }
            }
            if cents == nil, let known {
                Text("可计算部分 " + DisplayFormat.money(known, currency: currency)).font(.caption).foregroundStyle(.secondary)
            }
        }.font(.subheadline).accessibilityElement(children: .combine)
    }
    private var amount: some View { Text(DisplayFormat.money(cents, currency: currency)).fontWeight(.semibold).monospacedDigit() }
}

struct ProfitHero: View {
    let cents: Int64?
    let known: Int64?
    let currency: String
    var subtitle = "已实现收益"
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label(subtitle, systemImage: "chart.line.uptrend.xyaxis").font(.subheadline.weight(.medium))
                Spacer(); CurrencyMenu()
            }.foregroundStyle(.secondary)
            Text(DisplayFormat.money(cents, currency: currency))
                .font(.system(.largeTitle, design: .rounded, weight: .semibold))
                .monospacedDigit().foregroundStyle(ReaderStyle.profit(cents))
                .minimumScaleFactor(0.55).lineLimit(1)
                .contentTransition(.numericText())
                .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: cents)
            if cents == nil, let known {
                Text("可计算部分 " + DisplayFormat.money(known, currency: currency)).font(.subheadline).foregroundStyle(.secondary)
            }
            Text("依据已完成交易 · \(currency)").font(.caption).foregroundStyle(.secondary)
        }.accessibilityElement(children: .contain)
    }
}

struct InlineIssue: View {
    let message: String
    var retry: (() -> Void)? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(message, systemImage: "exclamationmark.circle").font(.subheadline)
                .foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
            if let retry { Button("重新读取", action: retry).buttonStyle(.bordered) }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
            .background(.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 18))
    }
}

struct ReaderEmpty: View {
    let symbol: String
    let title: String
    let message: String
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 34, weight: .light)).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity).padding(.vertical, 32).accessibilityElement(children: .combine)
    }
}

struct ReaderLoading: View {
    var title = "正在读取…"
    var body: some View { ProgressView(title).font(.subheadline).frame(maxWidth: .infinity).padding(.vertical, 22) }
}

struct ReaderNote: View {
    let text: String
    var body: some View {
        Label { Text(text).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "info.circle") }
            .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 4)
    }
}

struct ReaderToolbar: ViewModifier {
    @EnvironmentObject private var store: ReaderStore
    func body(content: Content) -> some View {
        content.toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { store.showSettings = true } label: { Image(systemName: "slider.horizontal.3") }
                    .accessibilityLabel("连接与设置")
            }
            ToolbarItem(placement: .topBarTrailing) { AccountMenu() }
        }
    }
}

extension View {
    func readerToolbar() -> some View { modifier(ReaderToolbar()) }
    func readerList() -> some View { scrollContentBackground(.hidden).background { ReaderBackdrop() } }
    @ViewBuilder func readerGlassControl() -> some View {
        if #available(iOS 26.0, *) { glassEffect(.regular.interactive(), in: .capsule) }
        else { background(.regularMaterial, in: Capsule()).overlay { Capsule().strokeBorder(.primary.opacity(0.06)) } }
    }
}

struct ReaderLaunchView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var revealed = false
    var body: some View {
        ZStack {
            ReaderBackdrop()
            VStack(spacing: 24) {
                Image("BrandMark").resizable().scaledToFit()
                    .frame(width: 156, height: 156)
                    .scaleEffect(revealed || reduceMotion ? 1 : 0.88)
                VStack(spacing: 8) {
                    Text("饰品交易账本").font(.system(.title, design: .rounded, weight: .semibold))
                    Text("交易有迹 · 收藏有数").font(.subheadline).foregroundStyle(.secondary)
                }.opacity(revealed ? 1 : 0)
            }.offset(y: -28)
        }.allowsHitTesting(false).accessibilityHidden(true)
            .onAppear { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.45)) { revealed = true } }
    }
}

struct PlatformMark: View {
    let platform: String
    var size: CGFloat = 36
    private var asset: String? { ["buff": "PlatformBUFF", "uu": "PlatformUU", "steam": "PlatformSteam"][platform] }
    var body: some View {
        Group {
            if let asset { Image(asset).resizable().scaledToFit() }
            else { Image(systemName: "archivebox").resizable().scaledToFit().padding(6).foregroundStyle(.secondary) }
        }.frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: size * 0.23))
            .accessibilityHidden(true)
    }
}
