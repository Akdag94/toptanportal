import XCTest

@testable import ToptanPortal

/// Cevrimdisi kuyrugun DISK BICIMI testleri.
///
/// Kuyruk dosyasi, sinyalin olmadigi bir depoda girilmis gercek siparisleri
/// tasir ve uygulama yeniden acilana kadar tek kopyasidir. Bicimi sessizce
/// bozulursa - bir alan adi degisir, bir tur `Codable` uyumunu kaybeder -
/// `diskteOku` bos dizi doner ve BEKLEYEN TUM SIPARISLER KAYBOLUR. Kayip
/// sessizdir: uygulama hatasiz acilir, kuyruk bos gorunur.
///
/// Bu testler o sessiz kaybi gurultulu hale getirir.
final class CevrimdisiKuyrukTests: XCTestCase {
    private func ornekIslem(
        tur: CevrimdisiKuyruk.IslemTuru = .siparis,
        durum: CevrimdisiKuyruk.Durum = .bekliyor
    ) -> CevrimdisiKuyruk.Islem {
        CevrimdisiKuyruk.Islem(
            id: UUID(),
            tur: tur,
            yol: "/orders",
            govde: Data(#"{"lines":[]}"#.utf8),
            idempotencyKey: UUID().uuidString,
            olusturmaZamani: Date(timeIntervalSince1970: 1_785_000_000),
            durum: durum,
            denemeSayisi: 2,
            sonHata: "Bağlantı yok; kayıt cihazda bekliyor.",
            ozet: "Mavi Kapı · 12 kalem"
        )
    }

    func testIslemDiskeYazilipGeriOkunabilir() throws {
        let islem = ornekIslem()

        let veri = try JSONEncoder().encode([islem])
        let okunan = try JSONDecoder().decode([CevrimdisiKuyruk.Islem].self, from: veri)

        XCTAssertEqual(okunan.count, 1)
        XCTAssertEqual(okunan[0].id, islem.id)
        XCTAssertEqual(okunan[0].govde, islem.govde)
        XCTAssertEqual(okunan[0].ozet, islem.ozet)
        XCTAssertEqual(okunan[0].denemeSayisi, 2)
    }

    /// Idempotency anahtari islem OLUSTURULURKEN uretilir ve tekrar
    /// denemelerde DEGISMEZ. Diskten okunan kaydin anahtari degisirse, ag
    /// zaman asimindan sonra yapilan ikinci gonderim sunucuda IKINCI BIR
    /// SIPARIS acar - mukerrer siparis sevk edilir ve fatura edilir.
    func testIdempotencyAnahtariDiskYolculugundaKorunur() throws {
        let islem = ornekIslem()

        let veri = try JSONEncoder().encode([islem])
        let okunan = try JSONDecoder().decode([CevrimdisiKuyruk.Islem].self, from: veri)

        XCTAssertEqual(okunan[0].idempotencyKey, islem.idempotencyKey)
    }

    /// Durum ve tur degerleri disk uzerinde METIN olarak durur. Ham degerin
    /// degismesi, eski surumde kuyruga girmis kayitlarin yeni surumde
    /// okunamamasi demektir - guncelleme aninda bekleyen siparisler kaybolur.
    func testDurumVeTurHamDegerleriSabittir() {
        XCTAssertEqual(CevrimdisiKuyruk.IslemTuru.siparis.rawValue, "siparis")
        XCTAssertEqual(CevrimdisiKuyruk.IslemTuru.tahsilat.rawValue, "tahsilat")
        XCTAssertEqual(CevrimdisiKuyruk.IslemTuru.ziyaret.rawValue, "ziyaret")

        XCTAssertEqual(CevrimdisiKuyruk.Durum.bekliyor.rawValue, "bekliyor")
        XCTAssertEqual(CevrimdisiKuyruk.Durum.gonderiliyor.rawValue, "gonderiliyor")
        XCTAssertEqual(CevrimdisiKuyruk.Durum.basarisiz.rawValue, "basarisiz")
        XCTAssertEqual(CevrimdisiKuyruk.Durum.elleBakilacak.rawValue, "elleBakilacak")
    }

    /// Kalici hata alan kayit "elle bakilacak" olur ve SILINMEZ; o sipariş
    /// gerçek bir ticari niyettir. Bicimin bu durumu tasiyabildigi kilitlenir.
    func testElleBakilacakKayitHatasiylaBirlikteSaklanir() throws {
        let islem = ornekIslem(durum: .elleBakilacak)

        let veri = try JSONEncoder().encode([islem])
        let okunan = try JSONDecoder().decode([CevrimdisiKuyruk.Islem].self, from: veri)

        XCTAssertEqual(okunan[0].durum, .elleBakilacak)
        XCTAssertEqual(okunan[0].sonHata, "Bağlantı yok; kayıt cihazda bekliyor.")
    }

    /// Bozuk bir kuyruk dosyasi COKMEYE yol acmamalidir: uygulama acilmali,
    /// kullanici en azindan yeni siparis girebilmelidir.
    func testBozukVeriCozumlemeHatasiVerir() {
        let bozuk = Data("{ bu json değil".utf8)

        XCTAssertThrowsError(try JSONDecoder().decode([CevrimdisiKuyruk.Islem].self, from: bozuk))
    }
}
