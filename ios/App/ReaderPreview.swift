#if DEBUG
import Foundation
import UIKit
import SwiftUI
import BuffReaderCore

/// Debug-only visual verification with synthetic local JSON. No device Keychain or cloud access.
@MainActor
enum ReaderPreview {
    static var active: Bool { ProcessInfo.processInfo.arguments.contains("--preview-fixtures") }
    static func configureWindow() {
        guard active else { return }
        #if targetEnvironment(macCatalyst)
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            scene.sizeRestrictions?.minimumSize = CGSize(width: 430, height: 900)
            scene.sizeRestrictions?.maximumSize = CGSize(width: 430, height: 900)
            scene.traitOverrides.horizontalSizeClass = .compact
        }
        #endif
        for window in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows) {
            window.overrideUserInterfaceStyle = ProcessInfo.processInfo.arguments.contains("--preview-dark") ? .dark : .light
        }
    }
    static func makeStore() -> ReaderStore? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--preview-fixtures"), args.indices.contains(index + 1) else { return nil }
        PreviewProtocol.directory = URL(fileURLWithPath: args[index + 1], isDirectory: true)
        let defaults = UserDefaults(suiteName: "com.buffhelper.reader.visual-preview")!
        defaults.set("https://preview.example.invalid", forKey: "reader.baseURL")
        defaults.set("account-1", forKey: "reader.selectedProfile")
        let store = ReaderStore(defaults: defaults, credentials: .init(read: { "synthetic-visual-preview-token" }, save: { _ in }, remove: {}), makeClient: { configuration in
            let session = URLSessionConfiguration.ephemeral; session.protocolClasses = [PreviewProtocol.self]
            return APIClient(configuration: configuration, sessionConfiguration: session)
        })
        if let tabIndex = args.firstIndex(of: "--preview-tab"), args.indices.contains(tabIndex + 1), let raw = Int(args[tabIndex + 1]), let tab = ReaderTab(rawValue: raw) { store.selectedTab = tab }
        return store
    }
}

struct ReaderPreviewAccessibility: ViewModifier {
    func body(content: Content) -> some View {
        if ReaderPreview.active {
            content
                .environment(\.dynamicTypeSize, ProcessInfo.processInfo.arguments.contains("--preview-large-text") ? .accessibility3 : .large)
        } else { content }
    }
}

private final class PreviewProtocol: URLProtocol, @unchecked Sendable {
    static var directory: URL?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard request.url?.host == "preview.example.invalid", let directory = Self.directory,
              let resource = request.url?.lastPathComponent,
              ["profiles", "overview", "orders", "holdings", "report", "alchemy", "sync-status"].contains(resource) else {
            client?.urlProtocol(self, didFailWithError: ReaderError.invalidURL); return
        }
        do {
            let data = try Data(contentsOf: directory.appendingPathComponent(resource + ".json"))
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: ReaderError.invalidResponse) }
    }
    override func stopLoading() {}
}
#endif
