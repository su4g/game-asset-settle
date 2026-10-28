import SwiftUI

@main
struct BuffReaderApp: App {
    @StateObject private var store: ReaderStore
    @Environment(\.scenePhase) private var scenePhase
    init() {
        #if DEBUG
        _store = StateObject(wrappedValue: ReaderPreview.makeStore() ?? ReaderStore())
        #else
        _store = StateObject(wrappedValue: ReaderStore())
        #endif
    }
    var body: some Scene {
        WindowGroup {
            ReaderRootView()
                .environmentObject(store)
                .tint(ReaderStyle.accent)
                .environment(\.locale, Locale(identifier: "zh_CN"))
                #if DEBUG
                .modifier(ReaderPreviewAccessibility())
                .onAppear { ReaderPreview.configureWindow() }
                #endif
                .task(id: scenePhase) {
                    if scenePhase == .active { await store.runForegroundRefresh() }
                }
                .onOpenURL { url in
                    guard url.isFileURL else { return }
                    Task { await store.importConnection(url) }
                }
        }
    }
}
