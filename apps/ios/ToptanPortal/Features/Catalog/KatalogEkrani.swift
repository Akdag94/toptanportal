import AVFoundation
import SwiftUI

/// Katalog ve barkodla hizli sepete ekleme.
///
/// "10 SANIYE KURALI": barista sabah stok sayarken telefonu eline alir, eksik
/// urunun barkodunu okutur, adet girer ve gonderir. Tasarim bu akisin onune
/// hicbir sey koymaz - arama zorunlu degildir, kategori gezinmesi yoktur,
/// birim varsayilan olarak SIPARIS BIRIMIDIR (genelde koli).
///
/// Barkod bir birime aitse o birim secili gelir: koli barkodu okutuldugunda
/// "adet" secili kalmasi, depoda 12 kat yanlis miktar girisi demektir.
@MainActor
final class KatalogModeli: ObservableObject {
    @Published var urunler: [CatalogProduct] = []
    @Published var arama = ""
    @Published var yukleniyor = false
    @Published var hata: String?
    @Published var sepeteEklendi: String?

    /// Barkod okutulunca acilan hizli ekleme kutusu.
    @Published var hizliUrun: CatalogProduct?
    @Published var hizliBirimId: String?
    @Published var hizliMiktar: Double = 1

    private var sonrakiImlec: String?

    func yukle(bastan: Bool = true) async {
        yukleniyor = true
        hata = nil

        do {
            let sorgu = arama.trimmingCharacters(in: .whitespacesAndNewlines)
            var yol = "/catalog/products?limit=30"
            if !sorgu.isEmpty {
                yol += "&q=\(sorgu.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
            }
            if !bastan, let sonrakiImlec {
                yol += "&cursor=\(sonrakiImlec)"
            }

            let sayfa: CatalogPage = try await APIClient.shared.request(yol)
            sonrakiImlec = sayfa.nextCursor
            urunler = bastan ? sayfa.items : urunler + sayfa.items
        } catch {
            hata = (error as? LocalizedError)?.errorDescription ?? "Katalog yüklenemedi."
        }

        yukleniyor = false
    }

    /// Barkodu sunucuda cozer.
    ///
    /// Cozumleme SUNUCUDA yapilir: barkod-urun eslesmesi Logo'dan gelir ve
    /// cihazda tutulan bir kopya, yeni urun eklendiginde eskir. Cevrimdisi
    /// senaryoda kullanici urunu arayarak ekler - yanlis urun eklemektense
    /// aramak iyidir.
    func barkodCoz(_ kod: String) async {
        do {
            struct Govde: Encodable { let barcode: String }
            let eslesme: BarcodeMatch = try await APIClient.shared.request(
                "/catalog/barcode",
                method: "POST",
                body: Govde(barcode: kod)
            )

            hizliUrun = eslesme.product
            hizliBirimId = eslesme.matchedUnitCode.flatMap { kod in
                eslesme.product.units.first(where: { $0.code == kod })?.id
            } ?? eslesme.product.varsayilanBirim?.id
            hizliMiktar = 1
        } catch {
            hata = "Bu barkod kataloğunuzda bulunamadı: \(kod)"
        }
    }

    func sepeteEkle(urun: CatalogProduct, birimId: String, miktar: Double) async {
        guard miktar > 0 else { return }

        do {
            let _: CartView = try await APIClient.shared.request(
                "/cart/items",
                method: "POST",
                body: CartItemInput(productId: urun.id, unitId: birimId, quantity: miktar)
            )

            sepeteEklendi = "\(urun.name) sepete eklendi"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            hizliUrun = nil
        } catch {
            hata = (error as? LocalizedError)?.errorDescription ?? "Ürün sepete eklenemedi."
        }
    }
}

struct KatalogEkrani: View {
    @StateObject private var model = KatalogModeli()
    @State private var tarayiciAcik = false
    @State private var kameraIzniVar = true

    var body: some View {
        VStack(spacing: 0) {
            aramaCubugu

            if let hata = model.hata {
                UyariSeridi(tur: .hata, mesaj: hata)
            }

            if let bildirim = model.sepeteEklendi {
                UyariSeridi(tur: .basari, mesaj: bildirim)
            }

            List {
                ForEach(model.urunler) { urun in
                    UrunSatiri(urun: urun) { birimId, miktar in
                        Task { await model.sepeteEkle(urun: urun, birimId: birimId, miktar: miktar) }
                    }
                }

                if model.yukleniyor {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
            }
            .listStyle(.plain)
            .refreshable { await model.yukle() }
        }
        /* Barkod dugmesi ALT SERITTE sabit durur: bir eliyle mal tasiyan
           kullanicinin basparmak bolgesi burasidir. */
        .safeAreaInset(edge: .bottom) {
            Button {
                izinKontrolEt()
            } label: {
                Label("Barkod Okut", systemImage: "barcode.viewfinder")
                    .frame(maxWidth: .infinity, minHeight: 56)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 16)
            .padding(.bottom, 10)
        }
        .navigationTitle("Katalog")
        .task { await model.yukle() }
        .sheet(isPresented: $tarayiciAcik) {
            if kameraIzniVar {
                BarkodTarayici(
                    okundu: { kod in
                        tarayiciAcik = false
                        Task { await model.barkodCoz(kod) }
                    },
                    kapat: { tarayiciAcik = false }
                )
                .ignoresSafeArea()
            } else {
                KameraIzniGerekli()
            }
        }
        .sheet(item: $model.hizliUrun) { urun in
            HizliEklemeKutusu(
                urun: urun,
                secilenBirimId: $model.hizliBirimId,
                miktar: $model.hizliMiktar
            ) { birimId, miktar in
                Task { await model.sepeteEkle(urun: urun, birimId: birimId, miktar: miktar) }
            }
        }
    }

    private var aramaCubugu: some View {
        HStack {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Ürün adı veya kodu", text: $model.arama)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit { Task { await model.yukle() } }
        }
        .padding(12)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func izinKontrolEt() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            kameraIzniVar = true
            tarayiciAcik = true
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { verildi in
                Task { @MainActor in
                    kameraIzniVar = verildi
                    tarayiciAcik = true
                }
            }
        default:
            kameraIzniVar = false
            tarayiciAcik = true
        }
    }
}

// MARK: - Alt gorunumler

private struct UrunSatiri: View {
    let urun: CatalogProduct
    let ekle: (String, Double) -> Void

    @State private var birimId: String?
    @State private var miktar: Double = 1

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(urun.name).font(.headline)

            HStack(spacing: 8) {
                Text(urun.code).font(.caption).foregroundStyle(.secondary)
                StokRozeti(durum: urun.stockStatus)
            }

            HStack {
                Picker("Birim", selection: Binding(
                    get: { birimId ?? urun.varsayilanBirim?.id ?? "" },
                    set: { birimId = $0 }
                )) {
                    ForEach(urun.units) { birim in
                        Text(birim.name).tag(birim.id)
                    }
                }
                .pickerStyle(.menu)

                Spacer()

                Stepper(value: $miktar, in: 1...999, step: 1) {
                    Text("\(Int(miktar))")
                        .monospacedDigit()
                        .frame(minWidth: 34, alignment: .trailing)
                }
                .labelsHidden()
                .fixedSize()

                Button {
                    if let secili = birimId ?? urun.varsayilanBirim?.id {
                        ekle(secili, miktar)
                    }
                } label: {
                    Image(systemName: "cart.badge.plus")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.bordered)
                .disabled(urun.stockStatus == .outOfStock)
            }

            /* Fiyat YALNIZCA sunucu gonderdiyse cizilir. Kor Siparis Modunda
               alan hic gelmez; "0,00" yazmak gizli fiyati bedava gostermek
               olurdu. */
            if let birim = urun.units.first(where: { $0.id == (birimId ?? urun.varsayilanBirim?.id) }),
               let fiyat = birim.unitPrice {
                Text(fiyat.paraFormatli())
                    .font(.subheadline.weight(.semibold))
            }
        }
        .padding(.vertical, 6)
    }
}

private struct StokRozeti: View {
    let durum: StockStatus

    var body: some View {
        Text(durum.etiket)
            .font(.caption.weight(.semibold))
            .foregroundStyle(renk)
    }

    private var renk: Color {
        switch durum {
        case .inStock: .green
        case .low: .orange
        case .outOfStock: .red
        }
    }
}

/// Barkod okunduktan sonra acilan kutu. Tek bir amaci vardir: miktari alip
/// sepete eklemek. Urun detayi, aciklama, gorsel YOKTUR - kullanici zaten
/// urunu elinde tutuyor.
private struct HizliEklemeKutusu: View {
    let urun: CatalogProduct
    @Binding var secilenBirimId: String?
    @Binding var miktar: Double
    let ekle: (String, Double) -> Void

    @Environment(\.dismiss) private var kapat

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Text(urun.name).font(.title3.weight(.semibold))
                Text(urun.code).font(.caption).foregroundStyle(.secondary)

                Picker("Birim", selection: Binding(
                    get: { secilenBirimId ?? urun.varsayilanBirim?.id ?? "" },
                    set: { secilenBirimId = $0 }
                )) {
                    ForEach(urun.units) { birim in
                        Text(birim.name).tag(birim.id)
                    }
                }
                .pickerStyle(.segmented)

                Stepper(value: $miktar, in: 1...999) {
                    HStack {
                        Text("Miktar")
                        Spacer()
                        Text("\(Int(miktar))").monospacedDigit().font(.title3)
                    }
                }

                Spacer()

                Button {
                    if let secili = secilenBirimId ?? urun.varsayilanBirim?.id {
                        ekle(secili, miktar)
                        kapat()
                    }
                } label: {
                    Text("Sepete Ekle").frame(maxWidth: .infinity, minHeight: 56)
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(20)
            .navigationTitle("Hızlı Ekle")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Vazgeç") { kapat() }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

extension Double {
    /// Turkce para bicimi. Tutar YOKSA cagrilmaz - opsiyonel alanlarda `if let`
    /// kullanilir; bu yontem yalnizca var olan bir tutari bicimler.
    func paraFormatli(_ kod: String = "TRY") -> String {
        let bicim = NumberFormatter()
        bicim.numberStyle = .currency
        bicim.currencyCode = kod
        bicim.locale = Locale(identifier: "tr_TR")
        return bicim.string(from: NSNumber(value: self)) ?? "\(self)"
    }
}
