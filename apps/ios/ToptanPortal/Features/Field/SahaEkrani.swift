import SwiftUI

/// Plasiyerin saha ekrani: bayi listesi, tahsilat ve ziyaret notu.
///
/// Tahsilat ve ziyaret notu da CEVRIMDISI KUYRUGA yazilir. Plasiyer bayinin
/// deposunda, bodrumda veya sanayi sitesinde calisir; tahsilati "sonra
/// girerim" demek, gun sonunda hatirlanmayan bir nakit demektir.
///
/// SAHA TAHSILATINDA KART VE DBS YOKTUR: plasiyer bunlari elinde dogrulayamaz.
/// Sunucu da bu yontemleri reddeder - arayuz onlari hic gostermeyerek
/// kullaniciyi bosuna denemeye sokmaz.
@MainActor
final class SahaModeli: ObservableObject {
    @Published var bayiler: [CompanyListItem] = []
    @Published var arama = ""
    @Published var yukleniyor = true
    @Published var hata: String?
    @Published var bildirim: String?
    @Published var bekleyenSayisi = 0
    @Published var elleBakilacaklar: [CevrimdisiKuyruk.Islem] = []

    func yukle() async {
        yukleniyor = true

        do {
            let sorgu = arama.trimmingCharacters(in: .whitespacesAndNewlines)
            var yol = "/companies?limit=50"
            if !sorgu.isEmpty {
                yol += "&q=\(sorgu.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
            }

            let sayfa: CompanyPage = try await APIClient.shared.request(yol)
            bayiler = sayfa.companies
            hata = nil
        } catch {
            /* Cevrimdisi durumda liste bos kalir ama HATA GOSTERILMEZ:
               plasiyer zaten kuyrukta bekleyen islemleri gorur ve "sunucuya
               ulasilamadi" uyarisi, kullanabilecegi bir sey yokken ekrani
               kirmizi yapar. */
            hata = bayiler.isEmpty ? "Bayi listesi şu anda yüklenemedi." : nil
        }

        bekleyenSayisi = await CevrimdisiKuyruk.shared.bekleyenSayisi
        elleBakilacaklar = await CevrimdisiKuyruk.shared.elleBakilacaklar
        yukleniyor = false
    }

    /// Tahsilati kuyruga yazar.
    func tahsilatKaydet(
        bayi: CompanyListItem,
        yontem: PaymentMethod,
        tutar: Double,
        referans: String
    ) async {
        struct Govde: Encodable {
            let companyId: String
            let method: String
            let amount: Double
            let reference: String?
        }

        let temizReferans = referans.trimmingCharacters(in: .whitespacesAndNewlines)

        guard
            tutar > 0,
            let govde = try? JSONEncoder().encode(
                Govde(
                    companyId: bayi.id,
                    method: yontem.rawValue,
                    amount: tutar,
                    reference: temizReferans.isEmpty ? nil : temizReferans
                )
            )
        else {
            hata = "Tutar sıfırdan büyük olmalıdır."
            return
        }

        await CevrimdisiKuyruk.shared.ekle(
            tur: .tahsilat,
            yol: "/finance/payments",
            govde: govde,
            ozet: "\(bayi.title) · \(tutar.paraFormatli()) \(yontem.etiket)"
        )

        bildirim = "\(tutar.paraFormatli()) tahsilat kaydedildi. Muhasebe onayından sonra bakiyeye işlenir."
        bekleyenSayisi = await CevrimdisiKuyruk.shared.bekleyenSayisi
    }

    /// Ziyaret notunu kuyruga yazar.
    func ziyaretKaydet(bayi: CompanyListItem, sonuc: String, not: String) async {
        struct Govde: Encodable {
            let companyId: String
            let outcome: String
            let note: String
        }

        let temizNot = not.trimmingCharacters(in: .whitespacesAndNewlines)

        guard
            temizNot.count >= 3,
            let govde = try? JSONEncoder().encode(
                Govde(companyId: bayi.id, outcome: sonuc, note: temizNot)
            )
        else {
            hata = "Not en az 3 karakter olmalıdır."
            return
        }

        await CevrimdisiKuyruk.shared.ekle(
            tur: .ziyaret,
            yol: "/visits",
            govde: govde,
            ozet: "\(bayi.title) · ziyaret notu"
        )

        bildirim = "Ziyaret notu kaydedildi."
        bekleyenSayisi = await CevrimdisiKuyruk.shared.bekleyenSayisi
    }

    func kuyrugaYenidenDene() async {
        await CevrimdisiKuyruk.shared.gonderimDene()
        bekleyenSayisi = await CevrimdisiKuyruk.shared.bekleyenSayisi
        elleBakilacaklar = await CevrimdisiKuyruk.shared.elleBakilacaklar
    }

    func kuyruktanSil(_ id: UUID) async {
        await CevrimdisiKuyruk.shared.sil(id)
        elleBakilacaklar = await CevrimdisiKuyruk.shared.elleBakilacaklar
        bekleyenSayisi = await CevrimdisiKuyruk.shared.bekleyenSayisi
    }
}

struct SahaEkrani: View {
    @StateObject private var model = SahaModeli()
    @State private var secilenBayi: CompanyListItem?

    var body: some View {
        VStack(spacing: 0) {
            if model.bekleyenSayisi > 0 {
                Button {
                    Task { await model.kuyrugaYenidenDene() }
                } label: {
                    UyariSeridi(tur: .dikkat, mesaj: "\(model.bekleyenSayisi) işlem gönderilmeyi bekliyor. Dokunarak şimdi deneyin.")
                }
                .buttonStyle(.plain)
            }

            if !model.elleBakilacaklar.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Gönderilemeyen kayıtlar")
                        .font(.subheadline.weight(.semibold))

                    ForEach(model.elleBakilacaklar) { islem in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(islem.ozet).font(.caption.weight(.medium))
                            if let hata = islem.sonHata {
                                Text(hata).font(.caption2).foregroundStyle(.secondary)
                            }
                            Button("Kaydı sil", role: .destructive) {
                                Task { await model.kuyruktanSil(islem.id) }
                            }
                            .font(.caption)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(.red.opacity(0.1))
            }

            if let hata = model.hata {
                UyariSeridi(tur: .hata, mesaj: hata)
            }

            if let bildirim = model.bildirim {
                UyariSeridi(tur: .basari, mesaj: bildirim)
            }

            List {
                ForEach(model.bayiler) { bayi in
                    Button {
                        secilenBayi = bayi
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(bayi.title).font(.headline)

                            Text([bayi.logoCariCode, bayi.city].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption)
                                .foregroundStyle(.secondary)

                            /* Bakiye YALNIZCA sunucu gonderdiyse cizilir. */
                            if let bakiye = bayi.balance {
                                HStack(spacing: 10) {
                                    Text("Bakiye: \(bakiye.paraFormatli(bayi.currency))")
                                        .font(.caption.weight(.semibold))

                                    if let gecikmis = bayi.overdueAmount, gecikmis > 0 {
                                        Text("Gecikmiş: \(gecikmis.paraFormatli(bayi.currency))")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(.red)
                                    }
                                }
                            }

                            if bayi.isBlocked {
                                Text("Sipariş girişine kapalı")
                                    .font(.caption)
                                    .foregroundStyle(.red)
                            }
                        }
                        .frame(minHeight: 56)
                    }
                    .buttonStyle(.plain)
                }
            }
            .listStyle(.plain)
            .searchable(text: $model.arama, prompt: "Bayi ara")
            .onSubmit(of: .search) { Task { await model.yukle() } }
            .refreshable { await model.yukle() }
        }
        .navigationTitle("Bayilerim")
        .task { await model.yukle() }
        .sheet(item: $secilenBayi) { bayi in
            BayiIslemKutusu(bayi: bayi, model: model)
        }
    }
}

/// Bayiye dokununca acilan islem kutusu: tahsilat veya ziyaret notu.
private struct BayiIslemKutusu: View {
    let bayi: CompanyListItem
    @ObservedObject var model: SahaModeli

    @Environment(\.dismiss) private var kapat
    @State private var sekme = 0
    @State private var yontem: PaymentMethod = .cash
    @State private var tutarMetni = ""
    @State private var referans = ""
    @State private var ziyaretSonucu = "NO_ORDER"
    @State private var not = ""

    private let ziyaretSecenekleri: [(String, String)] = [
        ("ORDER_TAKEN", "Sipariş Alındı"),
        ("NO_ORDER", "Sipariş Alınamadı"),
        ("COLLECTION", "Tahsilat"),
        ("COMPLAINT", "Şikâyet / Sorun"),
        ("INTRODUCTION", "Tanıtım"),
    ]

    var body: some View {
        NavigationStack {
            Form {
                Picker("", selection: $sekme) {
                    Text("Tahsilat").tag(0)
                    Text("Ziyaret Notu").tag(1)
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)

                if sekme == 0 {
                    Section {
                        Picker("Yöntem", selection: $yontem) {
                            /* Yalnizca sahada dogrulanabilen yontemler. Kart ve
                               DBS listede YOK - sunucu da reddeder. */
                            ForEach(PaymentMethod.sahaYontemleri, id: \.self) { secenek in
                                Text(secenek.etiket).tag(secenek)
                            }
                        }

                        TextField("Tutar", text: $tutarMetni)
                            .keyboardType(.decimalPad)

                        TextField("Referans (makbuz / çek no)", text: $referans)
                    } footer: {
                        Text("Nakit, çek ve senet fiziksel teslim gerektirir; muhasebe onayından sonra bakiyeye işlenir.")
                    }

                    Section {
                        Button {
                            let tutar = Double(tutarMetni.replacingOccurrences(of: ",", with: ".")) ?? 0
                            Task {
                                await model.tahsilatKaydet(
                                    bayi: bayi,
                                    yontem: yontem,
                                    tutar: tutar,
                                    referans: referans
                                )
                                kapat()
                            }
                        } label: {
                            Text("Tahsilatı Kaydet").frame(maxWidth: .infinity, minHeight: 50)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                } else {
                    Section {
                        Picker("Sonuç", selection: $ziyaretSonucu) {
                            ForEach(ziyaretSecenekleri, id: \.0) { deger, etiket in
                                Text(etiket).tag(deger)
                            }
                        }

                        TextField("Not", text: $not, axis: .vertical)
                            .lineLimit(3...6)
                    } footer: {
                        Text("Not kaydedildikten sonra değiştirilemez; düzeltme yeni bir notla yapılır.")
                    }

                    Section {
                        Button {
                            Task {
                                await model.ziyaretKaydet(bayi: bayi, sonuc: ziyaretSonucu, not: not)
                                kapat()
                            }
                        } label: {
                            Text("Ziyareti Kaydet").frame(maxWidth: .infinity, minHeight: 50)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            }
            .navigationTitle(bayi.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Kapat") { kapat() }
                }
            }
        }
    }
}
