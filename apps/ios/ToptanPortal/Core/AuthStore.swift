import Foundation
import LocalAuthentication
import Observation

/// Uygulamanin kimlik durumu.
///
/// Akis, sunucunun dondugu `outcome` degerine gore ilerler; hicbir adim
/// istemci tarafinda atlanamaz.
@MainActor
@Observable
final class AuthStore {
    enum Durum: Equatable {
        case aciliyor
        case cikisYapildi
        case kodBekleniyor(challengeToken: String, maskedPhone: String?)
        case kayitBekleniyor(challengeToken: String)
        case sifreDegisikligiBekleniyor(challengeToken: String)
        case kurtarmaKodlari([String])
        case girisYapildi(SessionUser)
    }

    private(set) var durum: Durum = .aciliyor
    private(set) var islemDevamEdiyor = false
    var hataMesaji: String?

    private let client = APIClient.shared

    var aktifKullanici: SessionUser? {
        if case .girisYapildi(let user) = durum { return user }
        return nil
    }

    // MARK: - Acilis

    func uygulamaAcildi() async {
        await client.setSessionInvalidationHandler { [weak self] in
            Task { @MainActor in
                self?.durum = .cikisYapildi
            }
        }

        guard await client.hasStoredSession else {
            durum = .cikisYapildi
            return
        }

        // Saklanmis oturum varsa once cihaz sahipligi dogrulanir. Depoda telefonu
        // masada kalan bir barista hesabinin baskasi tarafindan acilmasini engeller.
        guard await cihazSahipliginiDogrula() else {
            durum = .cikisYapildi
            return
        }

        guard await client.refreshSession() else {
            durum = .cikisYapildi
            return
        }

        do {
            let user: SessionUser = try await client.request("/auth/me")
            durum = .girisYapildi(user)
        } catch {
            await client.clearTokens()
            durum = .cikisYapildi
        }
    }

    /// Face ID / Touch ID ile cihaz sahipligi dogrulamasi.
    /// Biyometri tanimli degilse cihaz parolasina duser; ikisi de yoksa gecer.
    private func cihazSahipliginiDogrula() async -> Bool {
        let context = LAContext()
        context.localizedCancelTitle = "Vazgeç"

        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return true
        }

        do {
            return try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Kayıtlı oturumunuza erişmek için kimliğinizi doğrulayın."
            )
        } catch {
            return false
        }
    }

    // MARK: - Giris

    func girisYap(email: String, sifre: String) async {
        await islem {
            struct Body: Encodable {
                let email: String
                let password: String
                let device: DeviceInfo
            }

            let yanit: LoginResponse = try await self.client.request(
                "/auth/login",
                method: "POST",
                body: Body(email: email, password: sifre, device: APIClient.currentDevice()),
                allowRefresh: false
            )

            await self.yanitiIsle(yanit)
        }
    }

    func koduDogrula(_ kod: String, cihaziHatirla: Bool) async {
        guard case .kodBekleniyor(let challengeToken, _) = durum else { return }

        await islem {
            struct Body: Encodable {
                let challengeToken: String
                let code: String
                let trustDevice: Bool
                let device: DeviceInfo
            }

            let yanit: LoginResponse = try await self.client.request(
                "/auth/mfa/verify",
                method: "POST",
                body: Body(
                    challengeToken: challengeToken,
                    code: kod,
                    trustDevice: cihaziHatirla,
                    device: APIClient.currentDevice()
                ),
                allowRefresh: false
            )

            await self.yanitiIsle(yanit)
        }
    }

    func kaydiBaslat() async -> MfaEnrollStartResponse? {
        guard case .kayitBekleniyor(let challengeToken) = durum else { return nil }

        var sonuc: MfaEnrollStartResponse?

        await islem {
            struct Body: Encodable { let challengeToken: String }
            sonuc = try await self.client.request(
                "/auth/mfa/enrollment",
                method: "POST",
                body: Body(challengeToken: challengeToken),
                allowRefresh: false
            )
        }

        return sonuc
    }

    func kaydiOnayla(enrollmentToken: String, kod: String) async {
        await islem {
            struct Body: Encodable {
                let enrollmentToken: String
                let code: String
                let device: DeviceInfo
            }

            let yanit: MfaEnrollConfirmResponse = try await self.client.request(
                "/auth/mfa/enrollment/confirm",
                method: "POST",
                body: Body(
                    enrollmentToken: enrollmentToken,
                    code: kod,
                    device: APIClient.currentDevice()
                ),
                allowRefresh: false
            )

            await self.client.store(tokens: yanit.tokens)
            self.bekleyenKullanici = yanit.user
            self.durum = .kurtarmaKodlari(yanit.recoveryCodes)
        }
    }

    /// Kurtarma kodlari ekrani onaylandiktan sonra oturuma gecilir.
    private var bekleyenKullanici: SessionUser?

    func kurtarmaKodlariniOnayla() {
        guard let user = bekleyenKullanici else {
            durum = .cikisYapildi
            return
        }
        bekleyenKullanici = nil
        durum = .girisYapildi(user)
    }

    func zorunluSifreyiDegistir(yeniSifre: String) async {
        guard case .sifreDegisikligiBekleniyor(let challengeToken) = durum else { return }

        await islem {
            struct Body: Encodable {
                let challengeToken: String
                let newPassword: String
                let device: DeviceInfo
            }

            let yanit: LoginResponse = try await self.client.request(
                "/auth/password/forced-change",
                method: "POST",
                body: Body(
                    challengeToken: challengeToken,
                    newPassword: yeniSifre,
                    device: APIClient.currentDevice()
                ),
                allowRefresh: false
            )

            await self.yanitiIsle(yanit)
        }
    }

    func cikisYap(tumCihazlar: Bool = false) async {
        struct Body: Encodable { let allDevices: Bool }

        try? await client.requestVoid(
            "/auth/logout",
            method: "POST",
            body: Body(allDevices: tumCihazlar)
        )

        await client.clearTokens()
        durum = .cikisYapildi
    }

    func basaDon() {
        hataMesaji = nil
        durum = .cikisYapildi
    }

    // MARK: - Yardimcilar

    private func yanitiIsle(_ yanit: LoginResponse) async {
        switch yanit {
        case .success(let tokens, let user):
            await client.store(tokens: tokens)
            durum = .girisYapildi(user)

        case .mfaRequired(let challengeToken, _, let maskedPhone, _):
            durum = .kodBekleniyor(challengeToken: challengeToken, maskedPhone: maskedPhone)

        case .mfaEnrollmentRequired(let challengeToken, _):
            durum = .kayitBekleniyor(challengeToken: challengeToken)

        case .passwordChangeRequired(let challengeToken, _):
            durum = .sifreDegisikligiBekleniyor(challengeToken: challengeToken)
        }
    }

    private func islem(_ gorev: @escaping () async throws -> Void) async {
        islemDevamEdiyor = true
        hataMesaji = nil

        do {
            try await gorev()
        } catch let error as APIError {
            hataMesaji = error.errorDescription
        } catch {
            hataMesaji = "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin."
        }

        islemDevamEdiyor = false
    }
}
