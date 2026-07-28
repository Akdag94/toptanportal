import SwiftUI

/// Rutin sipariş şablonları — "10 saniye akışı".
///
/// ÜRÜNÜN ÇEKİRDEK VAADİ BUDUR: kafe sahibi her pazartesi aynı 14 kalemi
/// ister. O siparişi 14 kez arayarak girmek 4 dakika sürer; şablonu uygulamak
/// bir dokunuş. Bu ekran o dokunuşun önüne hiçbir şey koymaz — şablon listesi
/// açılışta gelir, dokunulur, sepet dolar.
///
/// ATLANAN ÜRÜNLER AÇIKÇA SÖYLENİR: şablondaki bir ürün satıştan kalkmışsa
/// sepete giremez. Bunu sessizce geçmek, kullanıcının eksik bir siparişi tam
/// sanarak göndermesi demektir — ve eksik gelen malı fark ettiğinde suçlanacak
/// olan uygulama olur.
@MainActor
final class SablonModeli: ObservableObject {
    @Published var sablonlar: [OrderTemplateView] = []
    @Published var yukleniyor = true
    @Published var hata: String?
    @Published var sonuc: String?
    @Published var atlananlar: [String] = []
    @Published var uygulanan: String?

    func yukle() async {
        yukleniyor = true
        do {
            sablonlar = try await APIClient.shared.request("/order-templates")
            hata = nil
        } catch {
            hata = (error as? LocalizedError)?.errorDescription ?? "Şablonlar yüklenemedi."
        }
        yukleniyor = false
    }

    func uygula(_ sablon: OrderTemplateView) async {
        uygulanan = sablon.id
        atlananlar = []

        do {
            let cevap: ApplyTemplateResult = try await APIClient.shared.request(
                "/order-templates/\(sablon.id)/apply",
                method: "POST"
            )

            atlananlar = cevap.skippedProducts
            sonuc = cevap.skippedProducts.isEmpty
                ? "\(sablon.name) sepete aktarıldı (\(cevap.cart.lines.count) kalem)."
                : "\(sablon.name) aktarıldı; \(cevap.skippedProducts.count) ürün eklenemedi."

            UINotificationFeedbackGenerator().notificationOccurred(
                cevap.skippedProducts.isEmpty ? .success : .warning
            )
        } catch {
            hata = (error as? LocalizedError)?.errorDescription ?? "Şablon uygulanamadı."
        }

        uygulanan = nil
    }
}

struct RutinSiparisEkrani: View {
    @StateObject private var model = SablonModeli()

    var body: some View {
        VStack(spacing: 0) {
            if let hata = model.hata {
                UyariSeridi(tur: .hata, mesaj: hata)
            }

            if let sonuc = model.sonuc {
                UyariSeridi(tur: model.atlananlar.isEmpty ? .basari : .dikkat, mesaj: sonuc)
            }

            if !model.atlananlar.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Sepete eklenemeyen ürünler")
                        .font(.subheadline.weight(.semibold))
                    ForEach(model.atlananlar, id: \.self) { ad in
                        Text("• \(ad)").font(.caption)
                    }
                    Text("Bu ürünler satışta olmayabilir. Kataloğu kontrol edin.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(.orange.opacity(0.12))
            }

            List {
                ForEach(model.sablonlar) { sablon in
                    Button {
                        Task { await model.uygula(sablon) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(sablon.name).font(.headline)
                                Text("\(sablon.itemCount) kalem\(sablon.isShared ? " · paylaşılan" : "")")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }

                            Spacer()

                            if model.uygulanan == sablon.id {
                                ProgressView()
                            } else {
                                Image(systemName: "arrow.right.circle.fill")
                                    .font(.title2)
                                    .foregroundStyle(.tint)
                            }
                        }
                        /* Dokunma hedefi 56 pt: kullanici ayakta, telefonu tek
                           elle tutuyor ve hedefi kacirmak akisi bozuyor. */
                        .frame(minHeight: 56)
                    }
                    .buttonStyle(.plain)
                }

                if model.sablonlar.isEmpty && !model.yukleniyor {
                    Text("Kayıtlı şablonunuz yok. Sepetinizi doldurup web panelinden şablon olarak kaydedebilirsiniz.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .listStyle(.plain)
            .refreshable { await model.yukle() }
            .overlay {
                if model.yukleniyor && model.sablonlar.isEmpty {
                    ProgressView()
                }
            }
        }
        .navigationTitle("Rutin Siparişim")
        .task { await model.yukle() }
    }
}
