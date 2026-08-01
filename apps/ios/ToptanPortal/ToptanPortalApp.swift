import SwiftUI

@main
struct ToptanPortalApp: App {
    @State private var auth = AuthStore()

    var body: some Scene {
        WindowGroup {
            KokEkran()
                .environment(auth)
                .task {
                    /* Cihaz bilgisi ANA AKTORDE, ilk agin cagrisindan once bir
                       kez okunur ve donar; sonrasinda arka plan akislari
                       (jeton yenileme) ana aktore atlamadan okuyabilir. */
                    CihazBilgisi.hazirla()
                    await auth.uygulamaAcildi()
                }
        }
    }
}

/// Kimlik durumuna gore hangi ekranin gosterilecegini belirler.
struct KokEkran: View {
    @Environment(AuthStore.self) private var auth

    var body: some View {
        Group {
            switch auth.durum {
            case .aciliyor:
                AcilisEkrani()

            case .cikisYapildi:
                GirisEkrani()

            case .kodBekleniyor(_, let maskedPhone):
                KodEkrani(maskedPhone: maskedPhone)

            case .kayitBekleniyor:
                KayitEkrani()

            case .sifreDegisikligiBekleniyor:
                ZorunluSifreEkrani()

            case .kurtarmaKodlari(let kodlar):
                KurtarmaKodlariEkrani(kodlar: kodlar)

            case .girisYapildi(let kullanici):
                AnaEkran(kullanici: kullanici)
            }
        }
        .animation(.easeInOut(duration: 0.22), value: auth.durum)
    }
}

private struct AcilisEkrani: View {
    var body: some View {
        VStack(spacing: 16) {
            Text("ToptanPortal")
                .font(.largeTitle.weight(.bold))
            ProgressView()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}
