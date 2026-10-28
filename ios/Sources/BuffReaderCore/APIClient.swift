import Foundation

public enum ReaderError: Error, LocalizedError, Equatable {
    case invalidURL, invalidToken, invalidProfile, unauthorized, unavailable, invalidResponse, cancelled, server(String)
    public var errorDescription: String? {
        switch self {
        case .invalidURL: return "连接地址必须是有效的 HTTPS 地址，且不能包含账号、查询参数或片段。"
        case .invalidToken: return "连接文件中的只读访问码无效，请重新导入。"
        case .invalidProfile: return "账户标识无效，请重新加载账户列表。"
        case .unauthorized: return "手机连接已失效，请导入新的连接文件。平台账号请在电脑助手重新登录。"
        case .unavailable: return "暂时无法连接服务器，请检查网络后重试。"
        case .invalidResponse: return "服务器返回的数据无法识别，原账户数据未被替换。"
        case .cancelled: return "已取消请求。"
        case .server(let message): return message
        }
    }
}

public struct ConnectionFile: Codable, Sendable {
    public let version: Int
    public let baseURL: String
    public let accessToken: String
    public init(version: Int = 1, baseURL: String, accessToken: String) {
        self.version = version; self.baseURL = baseURL; self.accessToken = accessToken
    }
    public func validated() throws -> ClientConfiguration {
        guard version == 1 else { throw ReaderError.invalidResponse }
        return try ClientConfiguration(baseURL: baseURL, accessToken: accessToken)
    }
}

public struct ClientConfiguration: Sendable {
    public static let defaultBaseURL = "https://ledger.example.com/buff-helper-api"
    public let baseURL: URL
    public let accessToken: String
    public init(baseURL: String, accessToken: String) throws {
        let raw = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var parts = URLComponents(string: raw), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.port == nil || parts.port == 443,
              !parts.percentEncodedPath.lowercased().contains("%2f"), !parts.percentEncodedPath.lowercased().contains("%5c"),
              !parts.path.split(separator: "/").contains(".."), !parts.path.contains("\\") else { throw ReaderError.invalidURL }
        parts.path = parts.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !parts.path.isEmpty { parts.path = "/" + parts.path }
        guard let url = parts.url else { throw ReaderError.invalidURL }
        let token = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.utf8.count >= 16, token.utf8.count <= 512,
              token.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }) else { throw ReaderError.invalidToken }
        self.baseURL = url; self.accessToken = token
    }
    public func request(resource: String, profileID: String? = nil, query: [URLQueryItem] = []) throws -> URLRequest {
        let allowed = Set(["overview", "orders", "holdings", "report", "alchemy", "sync-status"])
        var path = "/v1/profiles"
        if let profileID {
            guard profileID.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil else { throw ReaderError.invalidProfile }
            guard allowed.contains(resource) else { throw ReaderError.invalidURL }
            path += "/" + profileID + "/" + resource
        } else if resource != "profiles" { throw ReaderError.invalidURL }
        guard var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { throw ReaderError.invalidURL }
        parts.path += path
        if !query.isEmpty { parts.queryItems = query }
        guard let url = parts.url, url.host == baseURL.host else { throw ReaderError.invalidURL }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = "GET"
        request.setValue("Bearer " + accessToken, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
private struct Envelope<T: Decodable>: Decodable { let ok: Bool; let result: T?; let error: String?; let code: String? }

public final class APIClient: @unchecked Sendable {
    private let configuration: ClientConfiguration
    private let session: URLSession
    public init(configuration: ClientConfiguration, sessionConfiguration: URLSessionConfiguration = .ephemeral) {
        self.configuration = configuration
        sessionConfiguration.urlCache = nil
        sessionConfiguration.httpCookieStorage = nil
        sessionConfiguration.urlCredentialStorage = nil
        sessionConfiguration.httpShouldSetCookies = false
        sessionConfiguration.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: sessionConfiguration, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    public func fetch<T: Decodable & Sendable>(_ type: T.Type, resource: String, profileID: String? = nil, query: [URLQueryItem] = []) async throws -> T {
        let request = try configuration.request(resource: resource, profileID: profileID, query: query)
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch is CancellationError { throw ReaderError.cancelled }
        catch let error as URLError where error.code == .cancelled { throw ReaderError.cancelled }
        catch { throw ReaderError.unavailable }
        guard let http = response as? HTTPURLResponse, data.count <= 12 * 1024 * 1024 else { throw ReaderError.invalidResponse }
        if http.statusCode == 401 || http.statusCode == 403 { throw ReaderError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 429 { throw ReaderError.server("查询过于频繁，请稍后重试。") }
            throw ReaderError.unavailable
        }
        guard let envelope = try? JSONDecoder().decode(Envelope<T>.self, from: data), envelope.ok, let result = envelope.result else { throw ReaderError.invalidResponse }
        return result
    }
}
