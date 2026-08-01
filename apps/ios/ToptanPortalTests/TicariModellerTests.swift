import XCTest

@testable import ToptanPortal

/// Ticari modellerin testleri.
///
/// Asil is KOR SIPARIS KURALINI kilitlemektir: parasal alanlar OPSIYONELDIR ve
/// sunucu yetkisi olmayan kullaniciya alani HIC gondermez. Cozumleyicinin
/// eksik alanda `0` uretmesi, gizlenmis fiyati bedava gibi gostermek olurdu -
/// ve musteri onu gercek bir bedel sanabilir.
final class TicariModellerTests: XCTestCase {
    private func urunJSON(fiyatli: Bool) -> Data {
        let birim = fiyatli
            ? #"{"id":"u1","code":"KOLI","name":"Koli","conversionFactor":12,"isDefaultForOrder":true,"unitPrice":480}"#
            : #"{"id":"u1","code":"KOLI","name":"Koli","conversionFactor":12,"isDefaultForOrder":true}"#

        return Data(
            """
            {
              "id": "p1",
              "code": "KHV-001",
              "name": "Filtre Kahve 1 kg",
              "brand": null,
              "imageUrl": null,
              "baseUnitCode": "ADET",
              "units": [\(birim)],
              "stockStatus": "IN_STOCK"
            }
            """.utf8
        )
    }

    func testFiyatGoremeyenKullanicidaAlanNilKalir() throws {
        let urun = try JSONDecoder().decode(CatalogProduct.self, from: urunJSON(fiyatli: false))

        // `?? 0` degil, `nil`: sifir fiyat, gizlenmis fiyattan gorsel olarak
        // ayirt edilemez.
        XCTAssertNil(urun.varsayilanBirim?.unitPrice)
        XCTAssertNil(urun.availableQuantity)
        XCTAssertNil(urun.vatRate)
    }

    func testFiyatGorebilenKullanicidaAlanGelir() throws {
        let urun = try JSONDecoder().decode(CatalogProduct.self, from: urunJSON(fiyatli: true))

        XCTAssertEqual(urun.varsayilanBirim?.unitPrice, 480)
    }

    /// Barkod bir birime aitse O BIRIM secili gelir. Koli barkodu okutuldugunda
    /// "adet" secili kalmasi, depoda 12 kat yanlis miktar demektir.
    func testVarsayilanBirimSiparisBirimidir() {
        let adet = ProductUnitView(
            id: "u1", code: "ADET", name: "Adet",
            conversionFactor: 1, isDefaultForOrder: false, unitPrice: 40)
        let koli = ProductUnitView(
            id: "u2", code: "KOLI", name: "Koli",
            conversionFactor: 12, isDefaultForOrder: true, unitPrice: 480)

        let urun = CatalogProduct(
            id: "p1", code: "KHV-001", name: "Filtre Kahve", brand: nil, imageUrl: nil,
            baseUnitCode: "ADET", units: [adet, koli], stockStatus: .inStock,
            availableQuantity: nil, vatRate: nil)

        XCTAssertEqual(urun.varsayilanBirim?.code, "KOLI")
    }

    /// Hicbir birim varsayilan degilse ilk birim secilir - "birim secilmedi"
    /// diye bos kalan bir ekran, kullaniciyi siparis veremez halde birakir.
    func testVarsayilanYoksaIlkBirimSecilir() {
        let adet = ProductUnitView(
            id: "u1", code: "ADET", name: "Adet",
            conversionFactor: 1, isDefaultForOrder: false, unitPrice: nil)

        let urun = CatalogProduct(
            id: "p1", code: "X", name: "X", brand: nil, imageUrl: nil,
            baseUnitCode: "ADET", units: [adet], stockStatus: .low,
            availableQuantity: nil, vatRate: nil)

        XCTAssertEqual(urun.varsayilanBirim?.id, "u1")
    }

    /// Ham degerler sunucu sozlesmesidir; degismesi sessizce cozumleme hatasi
    /// uretir ve katalog bos gorunur.
    func testStokDurumuHamDegerleri() {
        XCTAssertEqual(StockStatus.inStock.rawValue, "IN_STOCK")
        XCTAssertEqual(StockStatus.low.rawValue, "LOW")
        XCTAssertEqual(StockStatus.outOfStock.rawValue, "OUT_OF_STOCK")
    }

    /// Sahada plasiyer yalnizca nakit, cek ve senet tahsil eder: kart ile
    /// tahsilat 3D akisi ister ve o akis bayinin kendi ekranindan gecer.
    func testSahaTahsilatYontemleriKartIcermez() {
        XCTAssertFalse(PaymentMethod.sahaYontemleri.contains(.creditCard))
        XCTAssertEqual(PaymentMethod.sahaYontemleri, [.cash, .cheque, .promissoryNote])
    }
}
