import Foundation
import Security

/// Anahtar Zinciri (Keychain) sarmalayicisi.
///
/// Yenileme jetonu YALNIZCA burada saklanir; UserDefaults'a asla yazilmaz.
/// Erisim sinifi `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`:
///  * cihaz yeniden baslatildiktan sonraki ilk kilit acmadan itibaren okunabilir
///    (arka plan senkronizasyonu icin gerekli),
///  * yedeklerle baska bir cihaza TASINMAZ.
enum KeychainStore {
    private static let service = "com.toptanportal.tokens"

    enum Key: String {
        case refreshToken = "refresh_token"
        case deviceId = "device_id"
    }

    @discardableResult
    static func save(_ value: String, for key: Key) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue
        ]

        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return true }

        guard updateStatus == errSecItemNotFound else { return false }

        var insertQuery = query
        insertQuery.merge(attributes) { current, _ in current }
        return SecItemAdd(insertQuery as CFDictionary, nil) == errSecSuccess
    }

    static func read(_ key: Key) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8)
        else { return nil }

        return value
    }

    @discardableResult
    static func delete(_ key: Key) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    /// Cihaz kimligi. Uygulama silinip yeniden kurulsa da ayni kalmasi icin
    /// Anahtar Zincirinde tutulur; boylece guvenilir cihaz kaydi korunur.
    static func deviceIdentifier() -> String {
        if let existing = read(.deviceId), existing.count >= 8 {
            return existing
        }
        let created = UUID().uuidString
        save(created, for: .deviceId)
        return created
    }
}
