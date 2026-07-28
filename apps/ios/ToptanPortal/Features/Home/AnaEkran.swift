import SwiftUI

/// Oturum acildiktan sonraki kok ekran.
///
/// Sekmeler kullanicinin YETKILERINDEN turetilir. Kor Sipariş Modundaki bir
/// hesapta "Cari Hesabım" sekmesi hic olusturulmaz - gorunmeyen bir kapiyi
/// zorlamasi gerektigi hissettirilmez.
struct AnaEkran: View {
    @Environment(AuthStore.self) private var auth

    let kullanici: SessionUser

    var body: some View {
        TabView {
            SiparisSekmesi(kullanici: kullanici)
                .tabItem { Label("Sipariş", systemImage: "cart.fill") }

            if kullanici.has(.catalogView) {
                NavigationStack { KatalogEkrani() }
                    .tabItem { Label("Katalog", systemImage: "barcode.viewfinder") }
            }

            if kullanici.has(.orderDraft) {
                NavigationStack { SepetEkrani() }
                    .tabItem { Label("Sepet", systemImage: "basket.fill") }
            }

            /* Saha sekmesi yalnizca plasiyerde: bayi listesi, saha tahsilati
               ve ziyaret notu tek ekranda toplanir - plasiyer bayinin kapisinda
               ucunu de arka arkaya yapar. */
            if kullanici.has(.visitNoteManage) || kullanici.has(.collectionRecord) {
                NavigationStack { SahaEkrani() }
                    .tabItem { Label("Saha", systemImage: "map.fill") }
            }

            HesapSekmesi(kullanici: kullanici)
                .tabItem { Label("Hesap", systemImage: "person.crop.circle.fill") }
        }
    }
}

// MARK: - Siparis

private struct SiparisSekmesi: View {
    let kullanici: SessionUser

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Tema.ogeBosluk) {
                    if kullanici.blindOrderMode {
                        UyariSeridi(
                            tur: .dikkat,
                            mesaj: "Bu hesapta fiyat, iskonto ve cari borç bilgileri gösterilmez. Oluşturduğunuz sipariş işletme yetkilinizin onayına gönderilir."
                        )
                    }

                    if let vekalet = kullanici.masqueradingAs {
                        UyariSeridi(
                            tur: .bilgi,
                            mesaj: "\(vekalet.companyTitle) adına işlem yapıyorsunuz."
                        )
                    }

                    NavigationLink {
                        RutinSiparisEkrani()
                    } label: {
                        HizliErisimKarti(
                            baslik: "Rutin Siparişim",
                            aciklama: "Kayıtlı şablonunuza dokunun, tüm liste tek seferde sepete gitsin.",
                            simge: "clock.arrow.circlepath"
                        )
                    }

                    if kullanici.has(.catalogView) {
                        NavigationLink {
                            KatalogEkrani()
                        } label: {
                            HizliErisimKarti(
                                baslik: "Barkod ile Ekle",
                                aciklama: "Ürünün barkodunu okutun, miktarı girin, sepete eklensin.",
                                simge: "barcode.viewfinder"
                            )
                        }
                    }
                }
                .padding(Tema.kenarBosluk)
            }
            .navigationTitle("Sipariş")
            .background(Color(.systemGroupedBackground))
        }
    }
}

/// Ana ekrandaki buyuk dokunma hedefi.
///
/// 56 pt yukseklik ve tam genislik: kullanici ayakta, tek elle ve genellikle
/// acele halinde. Kucuk bir baglanti burada her seferinde kacirilir.
private struct HizliErisimKarti: View {
    let baslik: String
    let aciklama: String
    let simge: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: simge)
                .font(.title2)
                .frame(width: 44)

            VStack(alignment: .leading, spacing: 3) {
                Text(baslik).font(.headline)
                Text(aciklama)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()

            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
        }
        .padding(16)
        .frame(minHeight: 56)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }
}

// MARK: - Hesap

private struct HesapSekmesi: View {
    @Environment(AuthStore.self) private var auth
    let kullanici: SessionUser

    @State private var cikisOnayi = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(kullanici.fullName)
                            .font(.headline)
                        Text(kullanici.email)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text(kullanici.roleLabel)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }

                if let isletme = kullanici.companyTitle {
                    Section("İşletme") {
                        Text(isletme)
                    }
                }

                Section("Güvenlik") {
                    LabeledContent(
                        "İki adımlı doğrulama",
                        value: kullanici.mfaEnrolled ? "Etkin" : "Tanımlı değil"
                    )
                    if kullanici.blindOrderMode {
                        LabeledContent("Kör Sipariş Modu", value: "Etkin")
                    }
                }

                Section {
                    Button("Çıkış yap", role: .destructive) { cikisOnayi = true }
                        .frame(minHeight: Tema.asgariDokunmaHedefi)
                }
            }
            .navigationTitle("Hesap")
            .confirmationDialog(
                "Oturumunuzu kapatmak istediğinize emin misiniz?",
                isPresented: $cikisOnayi,
                titleVisibility: .visible
            ) {
                Button("Bu cihazdan çık", role: .destructive) {
                    Task { await auth.cikisYap(tumCihazlar: false) }
                }
                Button("Tüm cihazlardan çık", role: .destructive) {
                    Task { await auth.cikisYap(tumCihazlar: true) }
                }
                Button("Vazgeç", role: .cancel) {}
            }
        }
    }
}
