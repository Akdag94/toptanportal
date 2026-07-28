import SwiftUI

/// Sepet ve siparis gonderimi.
///
/// CEVRIMDISI DAVRANIS: gonderim, dogrudan sunucuya degil CEVRIMDISI KUYRUGA
/// yazilir ve kuyruk hemen gonderimi dener. Kullanici baglantiyi beklemez;
/// "siparişiniz alındı" geri bildirimini aninda gorur ve depoda calismaya
/// devam eder.
///
/// Bu bir yalan DEGILDIR: kayit cihazda kalicidir, idempotency anahtari
/// tasir ve baglanti geldiginde gonderilir. Sunucu kalici bir hata dondurdugu
/// takdirde (stok bitti, cari bloke) kullanici "bekleyen işlemler" ekraninda
/// bunu gorur ve kayit sessizce kaybolmaz.
@MainActor
final class SepetModeli: ObservableObject {
    @Published var sepet: CartView?
    @Published var yukleniyor = true
    @Published var hata: String?
    @Published var gonderimSonucu: String?
    @Published var musteriNotu = ""

    func yukle() async {
        yukleniyor = true
        do {
            sepet = try await APIClient.shared.request("/cart")
            hata = nil
        } catch {
            hata = (error as? LocalizedError)?.errorDescription ?? "Sepet yüklenemedi."
        }
        yukleniyor = false
    }

    func miktarGuncelle(_ satir: CartLine, miktar: Double) async {
        do {
            struct Govde: Encodable { let quantity: Double }
            sepet = try await APIClient.shared.request(
                "/cart/items/\(satir.productId)/\(satir.unitId)",
                method: "PATCH",
                body: Govde(quantity: miktar)
            )
        } catch {
            hata = (error as? LocalizedError)?.errorDescription ?? "Miktar güncellenemedi."
        }
    }

    func satirSil(_ satir: CartLine) async {
        do {
            sepet = try await APIClient.shared.request(
                "/cart/items/\(satir.productId)/\(satir.unitId)",
                method: "DELETE"
            )
        } catch {
            hata = (error as? LocalizedError)?.errorDescription ?? "Satır silinemedi."
        }
    }

    /// Siparisi kuyruga yazar. Sunucu yaniti BEKLENMEZ.
    func siparisiGonder() async {
        guard let sepet, !sepet.lines.isEmpty else { return }

        struct Govde: Encodable { let customerNote: String? }
        let not = musteriNotu.trimmingCharacters(in: .whitespacesAndNewlines)

        guard let govde = try? JSONEncoder().encode(Govde(customerNote: not.isEmpty ? nil : not)) else {
            hata = "Sipariş hazırlanamadı."
            return
        }

        await CevrimdisiKuyruk.shared.ekle(
            tur: .siparis,
            yol: "/orders",
            govde: govde,
            ozet: "\(sepet.lines.count) kalem sipariş"
        )

        musteriNotu = ""
        gonderimSonucu = "Siparişiniz alındı. Bağlantı yoksa cihazınızda bekler ve otomatik gönderilir."

        /* Sepet sunucuda siparise donusunce bosalir; kuyruk gonderimi
           tamamlaninca yeniden okunur. Simdilik yerel gorunum korunur -
           kullaniciya bos bir sepet gosterip sonra "gonderilmedi" demek,
           guveni tumden yikar. */
        await yukle()
    }
}

struct SepetEkrani: View {
    @StateObject private var model = SepetModeli()
    @State private var bekleyenSayisi = 0

    var body: some View {
        VStack(spacing: 0) {
            if bekleyenSayisi > 0 {
                UyariSeridi(tur: .dikkat, mesaj: "\(bekleyenSayisi) işlem gönderilmeyi bekliyor. Bağlantı gelince otomatik gönderilecek.")
            }

            if let hata = model.hata {
                UyariSeridi(tur: .hata, mesaj: hata)
            }

            if let sonuc = model.gonderimSonucu {
                UyariSeridi(tur: .basari, mesaj: sonuc)
            }

            if let sepet = model.sepet, !sepet.lines.isEmpty {
                List {
                    ForEach(sepet.lines) { satir in
                        SepetSatiri(satir: satir) { miktar in
                            Task { await model.miktarGuncelle(satir, miktar: miktar) }
                        } sil: {
                            Task { await model.satirSil(satir) }
                        }
                    }

                    Section("Sipariş Notu") {
                        TextField("Teslimat saati, kapı kodu…", text: $model.musteriNotu, axis: .vertical)
                            .lineLimit(2...4)
                    }
                }
                .listStyle(.insetGrouped)
            } else if model.yukleniyor {
                Spacer(); ProgressView(); Spacer()
            } else {
                Spacer()
                Text("Sepetiniz boş")
                    .foregroundStyle(.secondary)
                Spacer()
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let sepet = model.sepet, !sepet.lines.isEmpty {
                VStack(spacing: 10) {
                    /* Toplam YALNIZCA sunucu gonderdiyse cizilir. Alt yetkili
                       hesapta tutar alanlari hic gelmez ve bu ekran onlarsiz
                       da tam calisir - siparis olusturulur, onaya duser. */
                    if let toplam = sepet.grandTotal {
                        HStack {
                            Text("Genel Toplam").font(.subheadline)
                            Spacer()
                            Text(toplam.paraFormatli(sepet.currency))
                                .font(.title3.weight(.bold))
                                .monospacedDigit()
                        }
                    } else if sepet.blindOrderMode {
                        Text("Tutar bilgisi hesabınızda gösterilmez. Siparişiniz yetkilinizin onayına gönderilecektir.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Button {
                        Task {
                            await model.siparisiGonder()
                            bekleyenSayisi = await CevrimdisiKuyruk.shared.bekleyenSayisi
                        }
                    } label: {
                        Text(sepet.hasStockIssue ? "Stok Sorunlu Satır Var" : "Siparişi Gönder")
                            .frame(maxWidth: .infinity, minHeight: 56)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(sepet.hasStockIssue)
                }
                .padding(16)
                .background(.bar)
            }
        }
        .navigationTitle("Sepet")
        .task {
            await model.yukle()
            bekleyenSayisi = await CevrimdisiKuyruk.shared.bekleyenSayisi
        }
    }
}

private struct SepetSatiri: View {
    let satir: CartLine
    let miktarDegisti: (Double) -> Void
    let sil: () -> Void

    @State private var miktar: Double

    init(satir: CartLine, miktarDegisti: @escaping (Double) -> Void, sil: @escaping () -> Void) {
        self.satir = satir
        self.miktarDegisti = miktarDegisti
        self.sil = sil
        _miktar = State(initialValue: satir.quantity)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(satir.productName).font(.headline)
            Text("\(satir.productCode) · \(satir.unitCode)")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Stepper(value: $miktar, in: 1...999, step: 1) {
                    Text("\(Int(miktar))").monospacedDigit()
                }
                .onChange(of: miktar) { _, yeni in
                    miktarDegisti(yeni)
                }

                Spacer()

                if let tutar = satir.lineTotal {
                    Text(tutar.paraFormatli()).font(.subheadline.weight(.semibold))
                }
            }

            if satir.stockStatus == .outOfStock {
                Text("Bu ürün tükendi; satırı çıkarın veya miktarı azaltın.")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .swipeActions {
            Button("Çıkar", role: .destructive, action: sil)
        }
    }
}
