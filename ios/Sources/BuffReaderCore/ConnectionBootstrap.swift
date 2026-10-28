import Foundation

public enum ConnectionBootstrap {
    public static let fileName = "BUFF-手机连接.buffconnection"

    /// Consume only the app's fixed private Documents file on first setup.
    /// The supplied configure operation must validate access and save Keychain
    /// before returning; failures leave the file available for a later retry.
    @MainActor
    @discardableResult
    public static func importIfNeeded(documents: URL, configured: Bool,
                                      configure: (ConnectionFile) async throws -> Void) async throws -> Bool {
        guard !configured else { return false }
        let file = documents.appendingPathComponent(fileName, isDirectory: false)
        guard FileManager.default.fileExists(atPath: file.path) else { return false }
        let attributes = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard attributes.isRegularFile == true, attributes.isSymbolicLink != true,
              let size = attributes.fileSize, size > 0, size <= 8192 else { throw ReaderError.invalidResponse }
        let value = try JSONDecoder().decode(ConnectionFile.self, from: Data(contentsOf: file))
        _ = try value.validated()
        try await configure(value)
        try FileManager.default.removeItem(at: file)
        return true
    }
}
