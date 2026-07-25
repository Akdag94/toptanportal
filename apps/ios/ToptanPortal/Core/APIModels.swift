import Foundation

// MARK: - Roller ve Yetkiler
// @toptanportal/contracts paketindeki tanimlarin birebir karsiligidir.
// Sunucu tarafinda bir deger eklendiginde burasi da guncellenmelidir; bilinmeyen
// degerler `bilinmeyen` durumuna duser ve arayuz guvenli tarafta kalir.

enum UserRole: String, Codable, Sendable {
    case superAdmin = "SUPER_ADMIN"
    case salesRep = "SALES_REP"
    case businessOwner = "BUSINESS_OWNER"
    case businessStaff = "BUSINESS_STAFF"
    case businessAccountant = "BUSINESS_ACCOUNTANT"

    var etiket: String {
        switch self {
        case .superAdmin: "Süper Admin"
        case .salesRep: "Satış Temsilcisi"
        case .businessOwner: "İşletme Ana Yetkilisi"
        case .businessStaff: "İşletme Alt Yetkilisi"
        case .businessAccountant: "İşletme Muhasebecisi"
        }
    }
}

/// Yetkiler serbest metin olarak tasinir; bilinmeyen bir yetki geldiginde
/// uygulama cokmez, yalnizca o yetkiye bagli ekran gizli kalir.
struct Permission: RawRepresentable, Codable, Hashable, Sendable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    static let catalogView = Permission(rawValue: "catalog:view")
    static let stockView = Permission(rawValue: "stock:view")
    static let priceView = Permission(rawValue: "price:view")
    static let balanceView = Permission(rawValue: "balance:view")
    static let invoiceDownload = Permission(rawValue: "invoice:download")
    static let paymentCreate = Permission(rawValue: "payment:create")
    static let orderDraft = Permission(rawValue: "order:draft")
    static let orderPlace = Permission(rawValue: "order:place")
    static let orderSubmitForApproval = Permission(rawValue: "order:submit-for-approval")
    static let orderApprove = Permission(rawValue: "order:approve")
    static let orderTemplateManage = Permission(rawValue: "order-template:manage")
    static let masquerade = Permission(rawValue: "session:masquerade")
}

// MARK: - Oturum

struct MasqueradeInfo: Codable, Hashable, Sendable {
    let companyId: String
    let companyTitle: String
    let startedAt: String
}

struct SessionUser: Codable, Hashable, Sendable {
    let id: String
    let email: String
    let fullName: String
    let role: UserRole
    let roleLabel: String
    let permissions: [Permission]
    let tenantId: String
    let companyId: String?
    let companyTitle: String?
    /// true ise arayuz HICBIR parasal degeri gostermez.
    let blindOrderMode: Bool
    let mfaEnrolled: Bool
    let masqueradingAs: MasqueradeInfo?

    func has(_ permission: Permission) -> Bool {
        permissions.contains(permission)
    }
}

struct TokenPair: Codable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int
}

// MARK: - Cihaz

struct DeviceInfo: Codable, Sendable {
    let deviceId: String
    let deviceName: String
    let platform: String
    let appVersion: String?
    let osVersion: String?
}

// MARK: - Giris akisi

/// Sunucunun `outcome` alanina gore cozulen ayrik birlesim.
enum LoginResponse: Sendable {
    case success(tokens: TokenPair, user: SessionUser)
    case mfaRequired(challengeToken: String, method: String, maskedPhone: String?, expiresIn: Int)
    case mfaEnrollmentRequired(challengeToken: String, expiresIn: Int)
    case passwordChangeRequired(challengeToken: String, expiresIn: Int)
}

extension LoginResponse: Decodable {
    private enum CodingKeys: String, CodingKey {
        case outcome, tokens, user, challengeToken, method, maskedPhone, expiresIn
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let outcome = try container.decode(String.self, forKey: .outcome)

        switch outcome {
        case "SUCCESS":
            self = .success(
                tokens: try container.decode(TokenPair.self, forKey: .tokens),
                user: try container.decode(SessionUser.self, forKey: .user)
            )
        case "MFA_REQUIRED":
            self = .mfaRequired(
                challengeToken: try container.decode(String.self, forKey: .challengeToken),
                method: try container.decodeIfPresent(String.self, forKey: .method) ?? "TOTP",
                maskedPhone: try container.decodeIfPresent(String.self, forKey: .maskedPhone),
                expiresIn: try container.decode(Int.self, forKey: .expiresIn)
            )
        case "MFA_ENROLLMENT_REQUIRED":
            self = .mfaEnrollmentRequired(
                challengeToken: try container.decode(String.self, forKey: .challengeToken),
                expiresIn: try container.decode(Int.self, forKey: .expiresIn)
            )
        case "PASSWORD_CHANGE_REQUIRED":
            self = .passwordChangeRequired(
                challengeToken: try container.decode(String.self, forKey: .challengeToken),
                expiresIn: try container.decode(Int.self, forKey: .expiresIn)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .outcome,
                in: container,
                debugDescription: "Bilinmeyen giriş sonucu: \(outcome)"
            )
        }
    }
}

struct MfaEnrollStartResponse: Decodable, Sendable {
    let secret: String
    let otpauthUri: String
    let qrCodeDataUrl: String
    let enrollmentToken: String
    let expiresIn: Int
}

struct MfaEnrollConfirmResponse: Decodable, Sendable {
    let recoveryCodes: [String]
    let tokens: TokenPair
    let user: SessionUser
}

struct RefreshResponse: Decodable, Sendable {
    let tokens: TokenPair
    let user: SessionUser
}

// MARK: - Hatalar

struct APIErrorBody: Decodable, Sendable {
    let statusCode: Int
    let code: String
    let message: String
    let details: [String: [String]]?
    let requestId: String
}

enum APIError: LocalizedError {
    case network
    case server(APIErrorBody)
    case decoding(String)
    case unauthorized

    var errorDescription: String? {
        switch self {
        case .network:
            "Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin."
        case .server(let body):
            body.message
        case .decoding:
            "Sunucudan beklenmeyen bir yanıt alındı."
        case .unauthorized:
            "Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın."
        }
    }

    var code: String? {
        if case .server(let body) = self { return body.code }
        return nil
    }
}
