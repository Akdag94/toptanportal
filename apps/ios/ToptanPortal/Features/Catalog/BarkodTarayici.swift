import AVFoundation
import SwiftUI

/// Barkod tarayici.
///
/// TASARIM: kamera acildiginda tarama HEMEN baslar; "tara" dugmesi yoktur.
/// Depoda kullanici bir eliyle mal tasir, digeriyle telefonu tutar - fazladan
/// her dokunus, kagit listeye donmenin bir adim daha yakinlasmasi demektir.
///
/// AYNI BARKOD ust uste okunmaz: kamera saniyede onlarca kare uretir ve ayni
/// etiketi 30 kez okumak, sepete 30 kalem eklemek olurdu. Ayni kod icin iki
/// okuma arasinda en az `tekrarBeklemesi` kadar sure gecmelidir.
struct BarkodTarayici: UIViewControllerRepresentable {
    let okundu: (String) -> Void
    let kapat: () -> Void

    func makeCoordinator() -> Koordinator {
        Koordinator(okundu: okundu)
    }

    func makeUIViewController(context: Context) -> TarayiciDenetleyici {
        let denetleyici = TarayiciDenetleyici()
        denetleyici.koordinator = context.coordinator
        return denetleyici
    }

    func updateUIViewController(_: TarayiciDenetleyici, context _: Context) {}

    final class Koordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        private let okundu: (String) -> Void
        private var sonKod: String?
        private var sonOkumaZamani = Date.distantPast
        private let tekrarBeklemesi: TimeInterval = 2.0

        init(okundu: @escaping (String) -> Void) {
            self.okundu = okundu
        }

        func metadataOutput(
            _: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from _: AVCaptureConnection
        ) {
            guard
                let nesne = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                let kod = nesne.stringValue,
                !kod.isEmpty
            else { return }

            let simdi = Date()

            if kod == sonKod, simdi.timeIntervalSince(sonOkumaZamani) < tekrarBeklemesi {
                return
            }

            sonKod = kod
            sonOkumaZamani = simdi

            /* Titresim geri bildirimi: depo gurultuludur ve ekrana bakmadan
               calisan kullanici, okumanin gerceklestigini BASKA turlu anlayamaz. */
            UINotificationFeedbackGenerator().notificationOccurred(.success)

            DispatchQueue.main.async { [okundu] in
                okundu(kod)
            }
        }
    }
}

/// Kamera oturumunu yoneten denetleyici.
///
/// Oturum arka plan kuyrugunda baslatilir: ana kuyrukta baslatmak, kamera
/// hazirlanirken arayuzu birkac yuz milisaniye dondurur ve bu, "uygulama
/// takildi" hissi verir.
final class TarayiciDenetleyici: UIViewController {
    var koordinator: BarkodTarayici.Koordinator?

    private let oturum = AVCaptureSession()
    private var onizleme: AVCaptureVideoPreviewLayer?
    private let kuyruk = DispatchQueue(label: "toptanportal.barkod")

    /// Toptancilikta karsilasilan bicimler. QR bilincli olarak DAHILDIR:
    /// bazi ureticiler kutu etiketinde QR kullanir.
    private let bicimler: [AVMetadataObject.ObjectType] = [
        .ean13, .ean8, .upce, .code128, .code39, .itf14, .qr, .dataMatrix,
    ]

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        kur()
    }

    private func kur() {
        guard
            let cihaz = AVCaptureDevice.default(for: .video),
            let girdi = try? AVCaptureDeviceInput(device: cihaz),
            oturum.canAddInput(girdi)
        else { return }

        oturum.addInput(girdi)

        let cikti = AVCaptureMetadataOutput()
        guard oturum.canAddOutput(cikti) else { return }
        oturum.addOutput(cikti)

        cikti.setMetadataObjectsDelegate(koordinator, queue: .main)
        /* Desteklenen bicimler ciktiya EKLENDIKTEN sonra atanir; once atamak
           sessizce hicbir bicimi etkinlestirmez. */
        cikti.metadataObjectTypes = bicimler.filter {
            cikti.availableMetadataObjectTypes.contains($0)
        }

        let katman = AVCaptureVideoPreviewLayer(session: oturum)
        katman.videoGravity = .resizeAspectFill
        katman.frame = view.layer.bounds
        view.layer.addSublayer(katman)
        onizleme = katman

        kuyruk.async { [oturum] in
            oturum.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        onizleme?.frame = view.layer.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        /* Oturum ekran kapanirken DURDURULUR. Calisir birakmak pili tuketir ve
           kamera gostergesini acik tutar - kullanici izlendigini dusunur. */
        kuyruk.async { [oturum] in
            if oturum.isRunning { oturum.stopRunning() }
        }
    }
}

/// Kamera izni istenmemis veya reddedilmisse gosterilen ekran.
struct KameraIzniGerekli: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.metering.unknown")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)

            Text("Barkod okumak için kamera izni gerekiyor")
                .font(.headline)
                .multilineTextAlignment(.center)

            Text("Ayarlar › ToptanPortal › Kamera yolundan izni açabilirsiniz. Ürünleri arayarak da sepete ekleyebilirsiniz.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button("Ayarları Aç") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(28)
    }
}
