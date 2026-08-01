import Foundation
import UIKit

/// Cihaz kimliginin anlik goruntusu.
///
/// NEDEN BIR ANLIK GORUNTU: `UIDevice.current` ANA AKTORE baglidir ve Swift 6
/// dilinde ona baska bir baglamdan erismek bir hatadir (Swift 5 dilinde
/// uyaridir). Cihaz bilgisi ise jeton yenileme gibi ARKA PLAN akislarindan
/// okunur; her okumada ana aktore atlamak, oturum yenilemesini arayuzun o
/// andaki mesguliyetine baglar - kullanicinin kaydirdigi bir liste yuzunden
/// gecikmis bir jeton yenilemesi, isteklerin 401 almasi demektir.
///
/// Cihaz adi ve isletim sistemi surumu oturum boyunca DEGISMEZ. Bu yuzden
/// deger uygulama acilirken ana aktorde BIR KEZ okunur ve dondurulur.
///
/// Hazirlanmadan once okunursa UIKit'e HIC DOKUNULMAZ; ayni bilgiler
/// `uname` ve `ProcessInfo` uzerinden uretilir. Bu, kullanicinin gordugu adi
/// biraz degistirir ("iPhone" yerine "iPhone15,2") ama girisi engellemez -
/// eksik bir cihaz adi, acilmayan bir oturumdan iyidir.
enum CihazBilgisi {
    /// Yazan ana aktor, okuyan aktorlerdir; kilit bu yuzden gercekten gerekir.
    private static let depo = Depo()

    /// Uygulama acilirken cagrilir (bkz. ToptanPortalApp).
    @MainActor
    static func hazirla() {
        depo.yaz(
            DeviceInfo(
                deviceId: KeychainStore.deviceIdentifier(),
                deviceName: UIDevice.current.name,
                platform: "IOS",
                appVersion: uygulamaSurumu(),
                osVersion: UIDevice.current.systemVersion
            )
        )
    }

    /// Her baglamdan okunabilir. Hazirlanmadiysa UIKit'siz karsiligi doner.
    static var anlik: DeviceInfo {
        depo.oku() ?? DeviceInfo(
            deviceId: KeychainStore.deviceIdentifier(),
            deviceName: donanimModeli(),
            platform: "IOS",
            appVersion: uygulamaSurumu(),
            osVersion: isletimSistemiSurumu()
        )
    }

    // MARK: - UIKit'siz karsiliklar

    private static func uygulamaSurumu() -> String? {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }

    private static func isletimSistemiSurumu() -> String {
        let surum = ProcessInfo.processInfo.operatingSystemVersion
        return "\(surum.majorVersion).\(surum.minorVersion).\(surum.patchVersion)"
    }

    /// Donanim tanimlayicisi ("iPhone15,2"). `uname` ana aktore bagli degildir.
    private static func donanimModeli() -> String {
        var sistem = utsname()
        uname(&sistem)

        let ad = withUnsafePointer(to: &sistem.machine) { isaretci in
            isaretci.withMemoryRebound(to: CChar.self, capacity: MemoryLayout.size(ofValue: sistem.machine)) {
                String(cString: $0)
            }
        }

        return ad.isEmpty ? "iOS cihazı" : ad
    }

    /// Kilit altinda tek bir deger tutar.
    ///
    /// `@unchecked Sendable`: es zamanlilik guvenligi derleyici tarafindan
    /// degil, KILIT tarafindan saglanir ve tum erisimler bu sinifin icindedir.
    private final class Depo: @unchecked Sendable {
        private let kilit = NSLock()
        private var deger: DeviceInfo?

        func yaz(_ bilgi: DeviceInfo) {
            kilit.lock()
            defer { kilit.unlock() }
            deger = bilgi
        }

        func oku() -> DeviceInfo? {
            kilit.lock()
            defer { kilit.unlock() }
            return deger
        }
    }
}
