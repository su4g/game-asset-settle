import XCTest
@testable import BuffReaderCore

@MainActor
final class ConnectionBootstrapTests: XCTestCase {
    private func fixture(_ body: Data? = nil) throws -> (URL, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("buff-bootstrap-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(ConnectionBootstrap.fileName)
        try (body ?? JSONEncoder().encode(ConnectionFile(baseURL: ClientConfiguration.defaultBaseURL,
                                                         accessToken: "synthetic-readonly-token-12345"))).write(to: file)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return (directory, file)
    }
    func testImportsAfterValidationAndDeletesOnlyAfterSuccessfulSave() async throws {
        let (directory, file) = try fixture()
        var saved = false
        let imported = try await ConnectionBootstrap.importIfNeeded(documents: directory, configured: false) { connection in
            XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
            XCTAssertEqual(try connection.validated().baseURL.absoluteString, ClientConfiguration.defaultBaseURL)
            saved = true
        }
        XCTAssertTrue(imported); XCTAssertTrue(saved)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }
    func testConfiguredDeviceDoesNotReadOrOverwriteInitialFile() async throws {
        let (directory, file) = try fixture(Data("not-json".utf8))
        let imported = try await ConnectionBootstrap.importIfNeeded(documents: directory, configured: true) { _ in XCTFail("已配置设备不能自动覆盖连接") }
        XCTAssertFalse(imported); XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
    }
    func testNetworkOrKeychainFailurePreservesTheOriginalFile() async throws {
        let (directory, file) = try fixture(), original = try Data(contentsOf: file)
        do {
            try await ConnectionBootstrap.importIfNeeded(documents: directory, configured: false) { _ in throw ReaderError.unauthorized }
            XCTFail("认证失败必须停止")
        } catch { XCTAssertEqual(error as? ReaderError, .unauthorized) }
        XCTAssertEqual(try Data(contentsOf: file), original)
    }
    func testInvalidTransportAndOversizedFileNeverReachConfigure() async throws {
        let invalid = try JSONEncoder().encode(ConnectionFile(baseURL: "http://example.com", accessToken: "synthetic-readonly-token-12345"))
        for data in [invalid, Data(repeating: 32, count: 8193)] {
            let (directory, file) = try fixture(data)
            do {
                try await ConnectionBootstrap.importIfNeeded(documents: directory, configured: false) { _ in XCTFail("无效文件不应触发请求或保存") }
                XCTFail("无效初始连接文件必须拒绝")
            } catch {}
            XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        }
    }
    func testAbsentInitialFileDoesNothing() async throws {
        let missing = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let imported = try await ConnectionBootstrap.importIfNeeded(documents: missing, configured: false) { _ in XCTFail("无文件不应创建连接") }
        XCTAssertFalse(imported)
    }
}
