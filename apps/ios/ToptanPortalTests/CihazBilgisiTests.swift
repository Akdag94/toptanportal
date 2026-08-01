import XCTest

@testable import ToptanPortal

/// Cihaz bilgisi testleri.
///
/// Cihaz alanlari sunucudaki GUVENILIR CIHAZ kaydina yazilir: "hangi
/// cihazlardan giris yapildi" sorusunun cevabi odur. Bos veya eksik bir alan,
/// o listeyi okunamaz kilar - ve okunamayan bir cihaz listesi, ele gecirilmis
/// bir oturumu fark etmenin yolunu kapatir.
///
/// Testler HAZIRLANMIS ve HAZIRLANMAMIS durumun ikisinde de gecerli olan
/// sozlesmeyi dogrular; test kosumunda uygulamanin acilis gorevinin calisip
/// calismadigina bagli kalmazlar.
final class CihazBilgisiTests: XCTestCase {
    func testCihazBilgisiHerZamanDoludur() {
        let bilgi = CihazBilgisi.anlik

        XCTAssertFalse(bilgi.deviceId.isEmpty)
        XCTAssertFalse(bilgi.deviceName.isEmpty)
        XCTAssertEqual(bilgi.platform, "IOS")
        XCTAssertNotNil(bilgi.osVersion)
    }

    /// Cihaz kimligi Anahtar Zincirinde durur ve OTURUMLAR ARASINDA aynidir;
    /// her okumada yeni bir kimlik uretmek, guvenilir cihaz listesini her
    /// giriste bir satir daha uzatirdi.
    func testCihazKimligiOkumalarArasindaDegismez() {
        XCTAssertEqual(CihazBilgisi.anlik.deviceId, CihazBilgisi.anlik.deviceId)
    }

    /// Ana aktorde hazirlandiktan sonra deger DONAR: sonraki okumalar ayni
    /// anlik goruntuyu verir.
    @MainActor
    func testHazirlandiktanSonraDeger_Donar() {
        CihazBilgisi.hazirla()

        let birinci = CihazBilgisi.anlik
        let ikinci = CihazBilgisi.anlik

        XCTAssertEqual(birinci.deviceName, ikinci.deviceName)
        XCTAssertEqual(birinci.osVersion, ikinci.osVersion)
    }
}
