import Foundation
import UIKit

/// ToptanPortal API istemcisi.
///
/// * Erisim jetonu YALNIZCA bellekte tutulur.
/// * 401 alindiginda yenileme jetonuyla bir kez otomatik yenilenir ve istek
///   tekrarlanir. Es zamanli istekler tek bir yenileme etrafinda toplanir;
///   aksi halde jeton rotasyonu yarisir ve sunucu "yeniden kullanim" sayarak
///   tum oturumlari kapatir.
actor APIClient {
    static let shared = APIClient()

    private let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    private var accessToken: String?
    private var refreshTask: Task<Bool, Never>?

    /// Oturum dusunce arayuzun haberdar olmasi icin.
    private var onSessionInvalidated: (@Sendable () -> Void)?

    private init() {
        let configured = Bundle.main.object(forInfoDictionaryKey: "TOPTANPORTAL_API_URL") as? String
        baseURL = URL(string: configured ?? "http://localhost:3001")!

        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        configuration.waitsForConnectivity = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration)
    }

    func setSessionInvalidationHandler(_ handler: @escaping @Sendable () -> Void) {
        onSessionInvalidated = handler
    }

    func setAccessToken(_ token: String?) {
        accessToken = token
    }

    var hasStoredSession: Bool {
        KeychainStore.read(.refreshToken) != nil
    }

    func store(tokens: TokenPair) {
        accessToken = tokens.accessToken
        KeychainStore.save(tokens.refreshToken, for: .refreshToken)
    }

    func clearTokens() {
        accessToken = nil
        KeychainStore.delete(.refreshToken)
    }

    // MARK: - Cihaz bilgisi

    nonisolated static func currentDevice() -> DeviceInfo {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return DeviceInfo(
            deviceId: KeychainStore.deviceIdentifier(),
            deviceName: UIDevice.current.name,
            platform: "IOS",
            appVersion: version,
            osVersion: UIDevice.current.systemVersion
        )
    }

    // MARK: - Istek

    func request<Response: Decodable>(
        _ path: String,
        method: String = "GET",
        body: Encodable? = nil,
        allowRefresh: Bool = true,
        as type: Response.Type = Response.self
    ) async throws -> Response {
        do {
            return try await perform(path, method: method, body: body, as: type)
        } catch APIError.unauthorized where allowRefresh && hasStoredSession {
            guard await refreshSession() else {
                throw APIError.unauthorized
            }
            return try await perform(path, method: method, body: body, as: type)
        }
    }

    /// Yanit govdesi olmayan uc noktalar icin.
    func requestVoid(
        _ path: String,
        method: String = "POST",
        body: Encodable? = nil
    ) async throws {
        struct Bos: Decodable {}
        _ = try? await request(path, method: method, body: body, as: Bos.self)
    }

    /// Hazir kodlanmis bir govdeyi gonderir (cevrimdisi kuyrugu icin).
    ///
    /// Kuyruktaki islem, OLUSTURULDUGU anda kodlanmis govdeyi ve kendi
    /// idempotency anahtarini tasir. Govdeyi gonderim aninda yeniden uretmek,
    /// aradan gecen surede degisen bir fiyat veya birim yuzunden kullanicinin
    /// onayladigindan FARKLI bir siparis gondermek olurdu.
    func requestRaw(
        _ path: String,
        method: String = "POST",
        rawBody: Data,
        idempotencyKey: String,
        allowRefresh: Bool = true
    ) async throws {
        do {
            try await performRaw(path, method: method, rawBody: rawBody, idempotencyKey: idempotencyKey)
        } catch APIError.unauthorized where allowRefresh && hasStoredSession {
            guard await refreshSession() else { throw APIError.unauthorized }
            try await performRaw(path, method: method, rawBody: rawBody, idempotencyKey: idempotencyKey)
        }
    }

    private func performRaw(
        _ path: String,
        method: String,
        rawBody: Data,
        idempotencyKey: String
    ) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/v1\(path)"))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = rawBody

        if let accessToken {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse

        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.network
        }

        guard let http = response as? HTTPURLResponse else { throw APIError.network }

        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw APIError.unauthorized }
            if let body = try? decoder.decode(APIErrorBody.self, from: data) {
                throw APIError.server(body)
            }
            throw APIError.network
        }
    }

    private func perform<Response: Decodable>(
        _ path: String,
        method: String,
        body: Encodable?,
        as _: Response.Type
    ) async throws -> Response {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/v1\(path)"))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(AnyEncodable(body))
        }

        if let accessToken {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse

        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.network
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.network
        }

        guard (200..<300).contains(http.statusCode) else {
            if let body = try? decoder.decode(APIErrorBody.self, from: data) {
                if http.statusCode == 401 { throw APIError.unauthorized }
                throw APIError.server(body)
            }
            if http.statusCode == 401 { throw APIError.unauthorized }
            throw APIError.network
        }

        if data.isEmpty, let empty = EmptyResponse() as? Response {
            return empty
        }

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    // MARK: - Yenileme

    @discardableResult
    func refreshSession() async -> Bool {
        if let refreshTask {
            return await refreshTask.value
        }

        guard let refreshToken = KeychainStore.read(.refreshToken) else {
            return false
        }

        let task = Task<Bool, Never> { [weak self] in
            guard let self else { return false }
            do {
                struct Body: Encodable {
                    let refreshToken: String
                    let device: DeviceInfo
                }
                let result: RefreshResponse = try await self.perform(
                    "/auth/refresh",
                    method: "POST",
                    body: Body(refreshToken: refreshToken, device: APIClient.currentDevice()),
                    as: RefreshResponse.self
                )
                await self.store(tokens: result.tokens)
                return true
            } catch {
                await self.clearTokens()
                await self.notifyInvalidated()
                return false
            }
        }

        refreshTask = task
        let result = await task.value
        refreshTask = nil
        return result
    }

    private func notifyInvalidated() {
        onSessionInvalidated?()
    }
}

struct EmptyResponse: Decodable, Sendable {}

/// Encodable protokolunu tip silme ile tasimak icin.
private struct AnyEncodable: Encodable {
    private let encodeClosure: (Encoder) throws -> Void

    init(_ wrapped: Encodable) {
        encodeClosure = wrapped.encode
    }

    func encode(to encoder: Encoder) throws {
        try encodeClosure(encoder)
    }
}
