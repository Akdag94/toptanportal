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
                KatalogSekmesi(kullanici: kullanici)
                    .tabItem { Label("Katalog", systemImage: "square.grid.2x2.fill") }
            }

            if kullanici.has(.balanceView) {
                CariSekmesi()
                    .tabItem { Label("Cari Hesap", systemImage: "doc.text.fill") }
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

                    Text("Rutin Siparişlerim")
                        .font(.title3.weight(.semibold))

                    Text(
                        "Kayıtlı şablonlarınız burada listelenir. Şablona dokunduğunuzda güncel stok ve limit kontrolü yapılarak tüm liste sepete aktarılır."
                    )
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
                .padding(Tema.kenarBosluk)
            }
            .navigationTitle("Sipariş")
            .background(Color(.systemGroupedBackground))
        }
    }
}

// MARK: - Katalog

private struct KatalogSekmesi: View {
    let kullanici: SessionUser

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Tema.ogeBosluk) {
                    Text(
                        kullanici.blindOrderMode
                            ? "Ürün adı, birimi ve stok durumu gösterilir."
                            : "Ürün adı, birimi, stok durumu ve size özel fiyatlar gösterilir."
                    )
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
                .padding(Tema.kenarBosluk)
            }
            .navigationTitle("Katalog")
            .background(Color(.systemGroupedBackground))
        }
    }
}

// MARK: - Cari

private struct CariSekmesi: View {
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Tema.ogeBosluk) {
                    Text("Bakiye, vade tarihleri ve e-Fatura evraklarınız muhasebe sisteminden anlık olarak getirilir.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(Tema.kenarBosluk)
            }
            .navigationTitle("Cari Hesap")
            .background(Color(.systemGroupedBackground))
        }
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
