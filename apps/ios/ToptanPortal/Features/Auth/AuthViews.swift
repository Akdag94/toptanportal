import SwiftUI

// MARK: - Giris

struct GirisEkrani: View {
    @Environment(AuthStore.self) private var auth

    @State private var email = ""
    @State private var sifre = ""
    @FocusState private var odak: Alan?

    private enum Alan { case email, sifre }

    private var gonderilebilir: Bool {
        email.contains("@") && sifre.count >= 6 && !auth.islemDevamEdiyor
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Tema.ogeBosluk) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("ToptanPortal")
                            .font(.largeTitle.weight(.bold))
                        Text("Hesabınıza giriş yapın.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.bottom, 12)

                    if let hata = auth.hataMesaji {
                        UyariSeridi(tur: .hata, mesaj: hata)
                    }

                    AlanKutusu(etiket: "E-posta") {
                        TextField("ornek@isletme.com", text: $email)
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($odak, equals: .email)
                            .submitLabel(.next)
                            .onSubmit { odak = .sifre }
                    }

                    AlanKutusu(etiket: "Şifre") {
                        SecureField("••••••••", text: $sifre)
                            .textContentType(.password)
                            .focused($odak, equals: .sifre)
                            .submitLabel(.go)
                            .onSubmit { gonder() }
                    }
                }
                .padding(.horizontal, Tema.kenarBosluk)
                .padding(.top, 48)
            }
            .scrollDismissesKeyboard(.interactively)

            // Birincil eylem basparmak bolgesinde sabit durur.
            VStack(spacing: 8) {
                Button("Giriş yap", action: gonder)
                    .buttonStyle(BirincilDugmeStili(yukleniyor: auth.islemDevamEdiyor))
                    .disabled(!gonderilebilir)

                Text("Girişleriniz yasal gereklilik gereği IP ve zaman damgasıyla kayıt altına alınır.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, Tema.kenarBosluk)
            .padding(.bottom, 12)
        }
        .background(Color(.systemBackground))
    }

    private func gonder() {
        guard gonderilebilir else { return }
        odak = nil
        Task { await auth.girisYap(email: email, sifre: sifre) }
    }
}

// MARK: - Iki adimli dogrulama

struct KodEkrani: View {
    @Environment(AuthStore.self) private var auth

    let maskedPhone: String?

    @State private var kod = ""
    @State private var cihaziHatirla = true
    @FocusState private var odakli: Bool

    private var gonderilebilir: Bool {
        kod.count >= 6 && !auth.islemDevamEdiyor
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Tema.ogeBosluk) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Doğrulama")
                            .font(.largeTitle.weight(.bold))
                        Text(
                            maskedPhone.map { "Kod \($0) numarasına gönderildi." }
                                ?? "Kimlik doğrulayıcı uygulamanızdaki kodu girin."
                        )
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    }
                    .padding(.bottom, 12)

                    if let hata = auth.hataMesaji {
                        UyariSeridi(tur: .hata, mesaj: hata)
                    }

                    TextField("000000", text: $kod)
                        .font(.system(size: 34, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .multilineTextAlignment(.center)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .focused($odakli)
                        .frame(maxWidth: .infinity, minHeight: 68)
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(Color(.secondarySystemBackground))
                        )
                        .onChange(of: kod) { _, yeni in
                            kod = String(yeni.filter(\.isNumber).prefix(6))
                            if kod.count == 6 { gonder() }
                        }

                    Toggle("Bu cihazı 30 gün hatırla", isOn: $cihaziHatirla)
                        .font(.subheadline)
                        .frame(minHeight: Tema.asgariDokunmaHedefi)
                }
                .padding(.horizontal, Tema.kenarBosluk)
                .padding(.top, 48)
            }
            .scrollDismissesKeyboard(.interactively)

            VStack(spacing: 4) {
                Button("Doğrula", action: gonder)
                    .buttonStyle(BirincilDugmeStili(yukleniyor: auth.islemDevamEdiyor))
                    .disabled(!gonderilebilir)

                Button("Vazgeç") { auth.basaDon() }
                    .buttonStyle(IkincilDugmeStili())
            }
            .padding(.horizontal, Tema.kenarBosluk)
            .padding(.bottom, 12)
        }
        .background(Color(.systemBackground))
        .onAppear { odakli = true }
    }

    private func gonder() {
        guard gonderilebilir else { return }
        Task { await auth.koduDogrula(kod, cihaziHatirla: cihaziHatirla) }
    }
}

// MARK: - Zorunlu 2FA kaydi

struct KayitEkrani: View {
    @Environment(AuthStore.self) private var auth

    @State private var kayit: MfaEnrollStartResponse?
    @State private var kod = ""
    @State private var hazirlaniyor = true

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Tema.ogeBosluk) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("İki Adımlı Doğrulama")
                            .font(.largeTitle.weight(.bold))
                        Text("Hesabınız için zorunludur. Kurulumu tamamlayın.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.bottom, 12)

                    if let hata = auth.hataMesaji {
                        UyariSeridi(tur: .hata, mesaj: hata)
                    }

                    if hazirlaniyor {
                        HStack {
                            ProgressView()
                            Text("Anahtarınız hazırlanıyor…")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, minHeight: 160)
                    } else if let kayit {
                        UyariSeridi(
                            tur: .bilgi,
                            mesaj: "Kodu kimlik doğrulayıcı uygulamanızla okutun veya anahtarı elle girin."
                        )

                        if let gorsel = qrGorseli(kayit.qrCodeDataUrl) {
                            Image(uiImage: gorsel)
                                .interpolation(.none)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: 220)
                                .padding(12)
                                .background(Color.white)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .frame(maxWidth: .infinity)
                                .accessibilityLabel("İki adımlı doğrulama QR kodu")
                        }

                        Text(kayit.secret)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .fill(Color(.secondarySystemBackground))
                            )

                        AlanKutusu(etiket: "Uygulamadaki 6 haneli kod") {
                            TextField("000000", text: $kod)
                                .keyboardType(.numberPad)
                                .textContentType(.oneTimeCode)
                                .font(.system(size: 22, weight: .semibold, design: .rounded))
                                .monospacedDigit()
                                .onChange(of: kod) { _, yeni in
                                    kod = String(yeni.filter(\.isNumber).prefix(6))
                                }
                        }
                    }
                }
                .padding(.horizontal, Tema.kenarBosluk)
                .padding(.top, 48)
            }
            .scrollDismissesKeyboard(.interactively)

            VStack(spacing: 4) {
                Button("Doğrula ve tamamla") {
                    guard let kayit else { return }
                    Task { await auth.kaydiOnayla(enrollmentToken: kayit.enrollmentToken, kod: kod) }
                }
                .buttonStyle(BirincilDugmeStili(yukleniyor: auth.islemDevamEdiyor))
                .disabled(kayit == nil || kod.count != 6 || auth.islemDevamEdiyor)

                Button("Vazgeç") { auth.basaDon() }
                    .buttonStyle(IkincilDugmeStili())
            }
            .padding(.horizontal, Tema.kenarBosluk)
            .padding(.bottom, 12)
        }
        .background(Color(.systemBackground))
        .task {
            kayit = await auth.kaydiBaslat()
            hazirlaniyor = false
        }
    }

    /// Sunucu QR kodunu `data:image/png;base64,...` bicimindeki bir URI olarak yollar.
    private func qrGorseli(_ dataUrl: String) -> UIImage? {
        guard let virgul = dataUrl.firstIndex(of: ","),
              let veri = Data(base64Encoded: String(dataUrl[dataUrl.index(after: virgul)...]))
        else { return nil }
        return UIImage(data: veri)
    }
}

// MARK: - Kurtarma kodlari

struct KurtarmaKodlariEkrani: View {
    @Environment(AuthStore.self) private var auth

    let kodlar: [String]
    @State private var kaydettim = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Tema.ogeBosluk) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Kurtarma Kodları")
                            .font(.largeTitle.weight(.bold))
                        Text("Bu kodlar bir daha gösterilmeyecek.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.bottom, 12)

                    UyariSeridi(
                        tur: .dikkat,
                        mesaj: "Telefonunuza erişemediğinizde hesabınıza girmenizi sağlar. Her kod yalnızca bir kez kullanılabilir."
                    )

                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        ForEach(kodlar, id: \.self) { kod in
                            Text(kod)
                                .font(.system(.callout, design: .monospaced))
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .background(
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .fill(Color(.secondarySystemBackground))
                                )
                        }
                    }
                    .textSelection(.enabled)

                    ShareLink(item: kodlar.joined(separator: "\n")) {
                        Label("Kodları paylaş", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity, minHeight: Tema.asgariDokunmaHedefi)
                    }

                    Toggle("Kodları güvenli bir yere kaydettim", isOn: $kaydettim)
                        .font(.subheadline)
                        .frame(minHeight: Tema.asgariDokunmaHedefi)
                }
                .padding(.horizontal, Tema.kenarBosluk)
                .padding(.top, 48)
            }

            Button("Devam et") { auth.kurtarmaKodlariniOnayla() }
                .buttonStyle(BirincilDugmeStili())
                .disabled(!kaydettim)
                .padding(.horizontal, Tema.kenarBosluk)
                .padding(.bottom, 12)
        }
        .background(Color(.systemBackground))
    }
}

// MARK: - Zorunlu sifre degisikligi

struct ZorunluSifreEkrani: View {
    @Environment(AuthStore.self) private var auth

    @State private var yeniSifre = ""
    @State private var tekrar = ""

    private var eslesmiyor: Bool { !tekrar.isEmpty && yeniSifre != tekrar }
    private var gonderilebilir: Bool {
        yeniSifre.count >= 10 && !eslesmiyor && !tekrar.isEmpty && !auth.islemDevamEdiyor
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Tema.ogeBosluk) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Şifre Değiştirin")
                            .font(.largeTitle.weight(.bold))
                        Text("Devam etmek için yeni bir şifre belirleyin.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.bottom, 12)

                    if let hata = auth.hataMesaji {
                        UyariSeridi(tur: .hata, mesaj: hata)
                    }

                    UyariSeridi(
                        tur: .bilgi,
                        mesaj: "En az 10 karakter; büyük harf, küçük harf ve rakam içermelidir."
                    )

                    AlanKutusu(etiket: "Yeni şifre") {
                        SecureField("••••••••••", text: $yeniSifre)
                            .textContentType(.newPassword)
                    }

                    AlanKutusu(etiket: "Yeni şifre (tekrar)") {
                        SecureField("••••••••••", text: $tekrar)
                            .textContentType(.newPassword)
                    }

                    if eslesmiyor {
                        Text("Şifreler eşleşmiyor.")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                .padding(.horizontal, Tema.kenarBosluk)
                .padding(.top, 48)
            }
            .scrollDismissesKeyboard(.interactively)

            Button("Şifreyi değiştir") {
                Task { await auth.zorunluSifreyiDegistir(yeniSifre: yeniSifre) }
            }
            .buttonStyle(BirincilDugmeStili(yukleniyor: auth.islemDevamEdiyor))
            .disabled(!gonderilebilir)
            .padding(.horizontal, Tema.kenarBosluk)
            .padding(.bottom, 12)
        }
        .background(Color(.systemBackground))
    }
}
