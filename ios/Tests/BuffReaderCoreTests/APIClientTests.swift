import Foundation
import XCTest
@testable import BuffReaderCore

private final class MockURLProtocol: URLProtocol {
    static var responseCode = 200
    static var responseData = Data()
    static var capturedRequest: URLRequest?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.capturedRequest = request
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.responseCode, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseData)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class APIClientTests: XCTestCase {
    func makeClient(status: Int, body: Data) throws -> APIClient {
        MockURLProtocol.responseCode = status
        MockURLProtocol.responseData = body
        MockURLProtocol.capturedRequest = nil
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return APIClient(configuration: try ClientConfiguration(baseURL: "https://example.invalid/buff-helper-api", accessToken: "synthetic-readonly-access-token"), sessionConfiguration: config)
    }
    func testReadRequestUsesHeaderAndDecodesEnvelope() async throws {
        let data = try Data(contentsOf: Bundle.module.url(forResource: "profiles", withExtension: "json", subdirectory: "Fixtures")!)
        let client = try makeClient(status: 200, body: data)
        let result = try await client.fetch(ProfilesResponse.self, resource: "profiles")
        XCTAssertEqual(result.profiles.count, 2)
        XCTAssertEqual(MockURLProtocol.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(MockURLProtocol.capturedRequest?.url?.path, "/buff-helper-api/v1/profiles")
        XCTAssertNil(MockURLProtocol.capturedRequest?.httpBody)
        XCTAssertEqual(MockURLProtocol.capturedRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-readonly-access-token")
    }
    func testAuthenticationErrorDoesNotSurfaceServerSecret() async throws {
        let client = try makeClient(status: 403, body: Data(#"{"ok":false,"error":"private-account-debug-secret"}"#.utf8))
        do { _ = try await client.fetch(ProfilesResponse.self, resource: "profiles"); XCTFail("Expected failure") }
        catch {
            XCTAssertEqual(error as? ReaderError, .unauthorized)
            XCTAssertFalse(error.localizedDescription.contains("private-account-debug-secret"))
        }
    }
    func testRedirectResponseIsNotTreatedAsAccountData() async throws {
        let client = try makeClient(status: 302, body: Data())
        do { _ = try await client.fetch(ProfilesResponse.self, resource: "profiles"); XCTFail("Expected failure") }
        catch { XCTAssertEqual(error as? ReaderError, .unavailable) }
    }
    func testInvalidSuccessfulPayloadDoesNotBecomeEmptySuccess() async throws {
        let client = try makeClient(status: 200, body: Data(#"{"ok":true,"result":{"unexpected":"missing profiles"}}"#.utf8))
        do { _ = try await client.fetch(ProfilesResponse.self, resource: "profiles"); XCTFail("Expected failure") }
        catch { XCTAssertEqual(error as? ReaderError, .invalidResponse) }
    }
}
