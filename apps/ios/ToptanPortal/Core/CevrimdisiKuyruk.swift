import Foundation

/// Cevrimdisi islem kuyrugu.
///
/// NEDEN VAR: depo bodrumdadir, soguk hava deposunda sinyal yoktur, plasiyer
/// bayinin deposunda calisir. Bu uygulamanin kullanildigi yerlerde internet
/// bir varsayim DEGILDIR. Baglanti yokken "tekrar deneyin" demek, kullaniciyi
/// kagida geri gonderir - ve kagit bir daha sisteme girmez.
///
/// TASARIM KARARLARI:
///
/// 1. Kuyruk DISKTE tutulur. Bellekte tutulan bir kuyruk, uygulama arka planda
///    sonlandirildiginda kaybolur; iOS bunu her an yapabilir.
///
/// 2. Her islemin kendi IDEMPOTENCY ANAHTARI vardir ve anahtar islem
///    OLUSTURULURKEN uretilir, gonderilirken degil. Ayni kayit iki kez
///    gonderilse bile sunucu ikinci siparisi acmaz.
///
/// 3. Basarisiz gonderim kuyruktan DUSMEZ; kalici hata (4xx) disinda tekrar
///    denenir. Kalici hatada kayit "elle bakilacak" olarak isaretlenir ve
///    kullaniciya gosterilir - sessizce silinmez, cunku o siparis gercek bir
///    ticari niyettir.
actor CevrimdisiKuyruk {
    static let shared = CevrimdisiKuyruk()

    enum IslemTuru: String, Codable, Sendable {
        case siparis
        case tahsilat
        case ziyaret
    }

    enum Durum: String, Codable, Sendable {
        case bekliyor
        case gonderiliyor
        case basarisiz
        /// Kalici hata - kullanici mudahalesi gerekir.
        case elleBakilacak
    }

    struct Islem: Codable, Sendable, Identifiable {
        let id: UUID
        let tur: IslemTuru
        let yol: String
        let govde: Data
        /// Islem olusturulurken uretilir; tekrar denemelerde DEGISMEZ.
        let idempotencyKey: String
        let olusturmaZamani: Date
        var durum: Durum
        var denemeSayisi: Int
        var sonHata: String?
        /// Kullaniciya gosterilecek kisa aciklama ("Mavi Kapı · 12 kalem").
        let ozet: String
    }

    private var islemler: [Islem] = []
    private let dosyaURL: URL
    private var gonderimSuruyor = false

    private init() {
        let klasor = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: klasor, withIntermediateDirectories: true)
        dosyaURL = klasor.appendingPathComponent("cevrimdisi-kuyruk.json")
        islemler = Self.diskteOku(dosyaURL)
    }

    // MARK: - Okuma

    var bekleyenSayisi: Int {
        islemler.filter { $0.durum == .bekliyor || $0.durum == .basarisiz }.count
    }

    var elleBakilacaklar: [Islem] {
        islemler.filter { $0.durum == .elleBakilacak }
    }

    var tumIslemler: [Islem] { islemler }

    // MARK: - Ekleme

    /// Islemi kuyruga alir ve hemen gonderimi dener.
    ///
    /// Cagiran taraf sonucu BEKLEMEZ: kullanici "kaydedildi" geri bildirimini
    /// aninda alir. Bu bilincli bir tercihtir - depoda calisan kisi, sunucunun
    /// yanitini bekleyerek durmamalidir.
    @discardableResult
    func ekle(
        tur: IslemTuru,
        yol: String,
        govde: Data,
        ozet: String
    ) -> UUID {
        let islem = Islem(
            id: UUID(),
            tur: tur,
            yol: yol,
            govde: govde,
            idempotencyKey: UUID().uuidString,
            olusturmaZamani: Date(),
            durum: .bekliyor,
            denemeSayisi: 0,
            sonHata: nil,
            ozet: ozet
        )

        islemler.append(islem)
        diskeYaz()

        Task { await gonderimDene() }
        return islem.id
    }

    /// Kalici hatali bir kaydi kuyruktan cikarir - yalnizca kullanici acikca
    /// vazgectiginde cagrilir.
    func sil(_ id: UUID) {
        islemler.removeAll { $0.id == id }
        diskeYaz()
    }

    // MARK: - Gonderim

    /// Bekleyen islemleri sirayla gonderir.
    ///
    /// SIRA KORUNUR: ayni bayiye once siparis sonra tahsilat girildiyse, ters
    /// sirada gonderilmesi tahsilatin kapatacagi belgeyi henuz olusmamis hale
    /// getirir. Es zamanli gonderim bu yuzden yapilmaz.
    func gonderimDene() async {
        guard !gonderimSuruyor else { return }
        gonderimSuruyor = true
        defer { gonderimSuruyor = false }

        /* Her turda SIRADAKI bekleyen islem alinir. Dizin yerine kimlikle
           calisilir: gonderim sirasinda kuyruga yeni bir kayit eklenirse
           dizinler kayar ve yanlis islem gonderilirdi. */
        while let sirada = islemler.first(where: { $0.durum == .bekliyor || $0.durum == .basarisiz }) {
            guard let indeks = islemler.firstIndex(where: { $0.id == sirada.id }) else { break }

            islemler[indeks].durum = .gonderiliyor
            islemler[indeks].denemeSayisi += 1

            do {
                try await gonder(islemler[indeks])
                islemler.removeAll { $0.id == sirada.id }
                diskeYaz()
            } catch let hata as APIError {
                guard let guncelIndeks = islemler.firstIndex(where: { $0.id == sirada.id }) else { return }

                if case .server(let govde) = hata, govde.statusCode >= 400, govde.statusCode < 500 {
                    /* Kalici hata: stok kalmamis, cari bloke, dogrulama hatasi.
                       Tekrar denemek ayni yaniti verir; kullanici gormeli. */
                    islemler[guncelIndeks].durum = .elleBakilacak
                    islemler[guncelIndeks].sonHata = govde.message
                    diskeYaz()
                    /* Kalici hatali kayit kuyrugu TIKAMAZ; sonraki islemle
                       devam edilir. */
                    continue
                }

                islemler[guncelIndeks].durum = .basarisiz
                islemler[guncelIndeks].sonHata = "Bağlantı yok; kayıt cihazda bekliyor."
                diskeYaz()
                /* Ag hatasinda tur BITER: baglanti yoksa sonraki islem de
                   basarisiz olacaktir ve her birini denemek pili tuketir. */
                return
            } catch {
                guard let guncelIndeks = islemler.firstIndex(where: { $0.id == sirada.id }) else { return }
                islemler[guncelIndeks].durum = .basarisiz
                islemler[guncelIndeks].sonHata = "Bağlantı yok; kayıt cihazda bekliyor."
                diskeYaz()
                return
            }
        }
    }

    private func gonder(_ islem: Islem) async throws {
        try await APIClient.shared.requestRaw(
            islem.yol,
            method: "POST",
            rawBody: islem.govde,
            idempotencyKey: islem.idempotencyKey
        )
    }

    // MARK: - Kalicilik

    private func diskeYaz() {
        do {
            let veri = try JSONEncoder().encode(islemler)
            /* Atomik yazim: uygulama yazim sirasinda sonlandirilirsa dosya
               yarim kalmaz. Yarim bir kuyruk dosyasi, tum bekleyen siparisleri
               okunamaz hale getirirdi. */
            try veri.write(to: dosyaURL, options: [.atomic, .completeFileProtection])
        } catch {
            // Disk yazilamazsa kuyruk bellekte kalir; bir sonraki denemede yazilir.
        }
    }

    private static func diskteOku(_ url: URL) -> [Islem] {
        guard let veri = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([Islem].self, from: veri)) ?? []
    }
}
