import SwiftUI

/// ToptanPortal tasarim dili.
///
/// Ilkeler:
///  * Sistem renkleri temel alinir; aydinlik/karanlik mod otomatik calisir.
///  * Dokunma hedefleri en az 44 pt, birincil eylemler 56 pt.
///  * Birincil eylem DAIMA ekranin alt seridinde durur - bir eliyle mal tasiyan
///    kullanicinin basparmagi bu bolgeye rahatca ulasir (Thumb Zone).
enum Tema {
    static let kenarBosluk: CGFloat = 20
    static let ogeBosluk: CGFloat = 14
    static let yaricap: CGFloat = 14
    static let birincilYukseklik: CGFloat = 56
    static let asgariDokunmaHedefi: CGFloat = 44
}

// MARK: - Birincil dugme

struct BirincilDugmeStili: ButtonStyle {
    var yukleniyor: Bool = false
    @Environment(\.isEnabled) private var etkin

    func makeBody(configuration: Configuration) -> some View {
        ZStack {
            configuration.label
                .font(.system(size: 17, weight: .semibold))
                .opacity(yukleniyor ? 0 : 1)

            if yukleniyor {
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(.white)
            }
        }
        .frame(maxWidth: .infinity, minHeight: Tema.birincilYukseklik)
        .foregroundStyle(.white)
        .background(
            RoundedRectangle(cornerRadius: Tema.yaricap, style: .continuous)
                .fill(Color.accentColor)
        )
        .opacity(etkin && !yukleniyor ? (configuration.isPressed ? 0.85 : 1) : 0.45)
        .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
        .contentShape(Rectangle())
    }
}

// MARK: - Ikincil dugme

struct IkincilDugmeStili: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .medium))
            .frame(maxWidth: .infinity, minHeight: Tema.asgariDokunmaHedefi)
            .foregroundStyle(Color.accentColor)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .contentShape(Rectangle())
    }
}

// MARK: - Alan

struct AlanKutusu<Icerik: View>: View {
    let etiket: String
    @ViewBuilder var icerik: Icerik

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(etiket)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)

            icerik
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color(.secondarySystemBackground))
                )
        }
    }
}

// MARK: - Uyari seridi

struct UyariSeridi: View {
    enum Tur {
        case hata, bilgi, dikkat, basari

        var renk: Color {
            switch self {
            case .hata: .red
            case .bilgi: .accentColor
            case .dikkat: .orange
            case .basari: .green
            }
        }

        var simge: String {
            switch self {
            case .hata: "exclamationmark.triangle.fill"
            case .bilgi: "info.circle.fill"
            case .dikkat: "eye.slash.fill"
            case .basari: "checkmark.circle.fill"
            }
        }
    }

    let tur: Tur
    let mesaj: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: tur.simge)
                .font(.system(size: 15, weight: .semibold))
            Text(mesaj)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(tur.renk)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(tur.renk.opacity(0.12))
        )
        .accessibilityElement(children: .combine)
    }
}
