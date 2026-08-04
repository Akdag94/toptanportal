namespace ToptanPortal.LogoBridge.Configuration;

/// <summary>
/// Koprunun tum yapilandirmasi. Uygulama ACILIRKEN dogrulanir; eksik bir deger
/// varsa surec hicbir istek almadan durur.
///
/// Kopru sirket ici agda, gozetimsiz calisir. Yanlis yapilandirmayla ayakta
/// kalmasi, hic ayaga kalkmamasindan tehlikelidir: yanlis firma numarasiyla
/// acilan bir kopru, baska bir sirketin stok verisini portale tasir.
///
/// `record` OLMASININ SEBEBI TESTLERDIR: bir alani degistirip geri kalani
/// koruyan `with` ifadesi, her testin tum alanlari yeniden yazmasini onler.
/// Yalnizca veri tasiyan, degismez bir yapilandirma nesnesi icin dogru sekil
/// zaten budur.
/// </summary>
public sealed record BridgeOptions
{
    public const string SectionName = "Bridge";

    /// <summary>Logo veritabani baglanti dizesi (MSSQL).</summary>
    public string ConnectionString { get; init; } = string.Empty;

    /// <summary>Logo firma numarasi. Tablo adlarina gomulur: LG_<c>001</c>_ITEMS.</summary>
    public int FirmNumber { get; init; }

    /// <summary>Logo donem numarasi. Yil sonu donem devrinde DEGISIR.</summary>
    public int PeriodNumber { get; init; } = 1;

    /// <summary>
    /// Kabul edilen istemci sertifikalarinin SHA-256 parmak izleri.
    ///
    /// Yalnizca "gecerli bir sertifika" yetmez: bulutun CA'si baska sertifikalar
    /// da imzalayabilir. Parmak izi listesi, tuneli TEK bir istemciye kilitler.
    /// </summary>
    public string[] AllowedClientThumbprints { get; init; } = Array.Empty<string>();

    /// <summary>Bir fark isteginde donulebilecek azami satir.</summary>
    public int MaxPageSize { get; init; } = 1000;

    /// <summary>
    /// Logo Object Service adresi. Siparis yazimi buraya devredilir.
    ///
    /// Tanimsizsa siparis yazimi KALICI hata doner - sessizce basarili
    /// sayilmaz. Yapilandirilmamis bir kopruden "tamam" yaniti almak, portalde
    /// siparisi iletilmis gostermek demektir; Logo'da hicbir sey yokken.
    /// </summary>
    public string? ObjectServiceUrl { get; init; }

    /// <summary>
    /// Stok karti yazim adresi. Portalde acilan/duzenlenen urun buraya gider.
    ///
    /// Siparis adresinden AYRI tutulur: Logo tarafinda siparis fisi ile stok
    /// karti farkli nesnelerdir ve cogu kurulumda farkli uclardan yazilir.
    /// Tek adres varsaymak, katalog yazimini calisiyor gibi gosterip siparis
    /// ucuna kart gondermeye calisirdi.
    /// </summary>
    public string? ObjectServiceItemUrl { get; init; }

    /// <summary>Fiyat karti yazim adresi.</summary>
    public string? ObjectServicePriceUrl { get; init; }

    /// <summary>
    /// Object Service kimlik anahtari. Servis kimlik dogrulamasi istiyorsa
    /// doldurulur; sirket ici agda "zaten kapali ag" varsayimi, ayni aga giren
    /// her cihazi Logo'ya siparis yazabilir hale getirir.
    /// </summary>
    public string? ObjectServiceApiKey { get; init; }

    /// <summary>
    /// Siparis yaziminin zaman asimi. Logo tarafinda yazma yavastir; okuma
    /// cagrilarindan belirgin sekilde uzun tutulur.
    /// </summary>
    public int ObjectServiceTimeoutSeconds { get; init; } = 30;

    /// <summary>
    /// Okuma sorgularinin zaman asimi.
    ///
    /// SINIRSIZ BEKLEYEN BIR SORGU, KOPRUYU KILITLER: Logo tarafinda kilitlenen
    /// tek bir tablo, zaman asimi olmadiginda koprunun tum baglanti havuzunu
    /// tuketir ve saglik ucu dahil hicbir istek yanit alamaz.
    /// </summary>
    public int CommandTimeoutSeconds { get; init; } = 30;

    /// <summary>
    /// Ayni anda islenecek azami istek.
    ///
    /// Kopru, Logo veritabanini portalin yukune karsi KORUYAN taraftir. Bulut
    /// tarafindaki bir dongu hatasi, sinir olmadiginda muhasebe sistemini
    /// yavaslatir; yavaslayan muhasebe sistemi, portalden cok daha pahali bir
    /// aksamadir.
    /// </summary>
    public int MaxConcurrentRequests { get; init; } = 16;

    public IEnumerable<string> Validate()
    {
        if (string.IsNullOrWhiteSpace(ConnectionString))
        {
            yield return "Bridge:ConnectionString tanımlı olmalıdır.";
        }

        if (FirmNumber is < 1 or > 999)
        {
            yield return "Bridge:FirmNumber 1-999 aralığında olmalıdır.";
        }

        if (PeriodNumber is < 1 or > 99)
        {
            yield return "Bridge:PeriodNumber 1-99 aralığında olmalıdır.";
        }

        if (AllowedClientThumbprints.Length == 0)
        {
            yield return
                "Bridge:AllowedClientThumbprints boş bırakılamaz. Boş liste, geçerli " +
                "sertifika taşıyan HERKESİN köprüye bağlanabilmesi demektir.";
        }

        foreach (var thumbprint in AllowedClientThumbprints)
        {
            var temiz = thumbprint.Replace(":", string.Empty).Replace(" ", string.Empty).Trim();

            /* SHA-256 parmak izi 64 hex karakterdir. SHA-1 parmak izi (40
               karakter) yapistiran bir kurulum, listeyi HICBIR sertifikanin
               eslesmedigi hale getirir ve bu ancak ilk istekte, "sertifika
               kabul edilmedi" mesajiyla anlasilir. */
            if (temiz.Length != 64 || !temiz.All(Uri.IsHexDigit))
            {
                yield return
                    $"Bridge:AllowedClientThumbprints içindeki \"{thumbprint}\" geçerli bir " +
                    "SHA-256 parmak izi değil (64 onaltılık karakter olmalıdır).";
            }
        }

        if (MaxPageSize is < 1 or > 10_000)
        {
            yield return "Bridge:MaxPageSize 1-10000 aralığında olmalıdır.";
        }

        if (CommandTimeoutSeconds is < 1 or > 600)
        {
            yield return "Bridge:CommandTimeoutSeconds 1-600 aralığında olmalıdır.";
        }

        if (ObjectServiceTimeoutSeconds is < 1 or > 600)
        {
            yield return "Bridge:ObjectServiceTimeoutSeconds 1-600 aralığında olmalıdır.";
        }

        if (MaxConcurrentRequests is < 1 or > 256)
        {
            yield return "Bridge:MaxConcurrentRequests 1-256 aralığında olmalıdır.";
        }

        /* Adres tanimliysa GECERLI BIR HTTP ADRESI olmalidir. Yazim hatasi
           tasiyan bir adres, ilk siparis gelene kadar sessiz kalir ve o siparis
           "Logo kabul etmedi" diye olu isaretlenir - oysa Logo o istegi hic
           gormemistir.

           SEMA DENETIMI SART: `Uri.TryCreate` tek basina yetmez, cunku
           "logo-sunucu:8080/orders" gibi sema unutulmus bir adresi GECERLI
           sayar - onu "logo-sunucu" semali bir adres olarak ayristirir. Boyle
           bir adres dogrulamadan gecer, sonra `HttpClient` tarafindan
           reddedilir; yani hata acilista degil, ilk siparis gonderiminde
           ortaya cikar. */
        foreach (var (ad, adres) in new[]
                 {
                     ("Bridge:ObjectServiceUrl", ObjectServiceUrl),
                     ("Bridge:ObjectServiceItemUrl", ObjectServiceItemUrl),
                     ("Bridge:ObjectServicePriceUrl", ObjectServicePriceUrl),
                 })
        {
            if (string.IsNullOrWhiteSpace(adres))
            {
                continue;
            }

            var gecerli = Uri.TryCreate(adres, UriKind.Absolute, out var ayristirilan)
                          && (ayristirilan.Scheme == Uri.UriSchemeHttp
                              || ayristirilan.Scheme == Uri.UriSchemeHttps);

            if (!gecerli)
            {
                yield return $"{ad} http:// veya https:// ile başlayan mutlak bir adres olmalıdır.";
            }
        }

        /* KATALOG YAZIMI YA TAMDIR YA DA YOKTUR.
           Yalnizca kart adresi tanimliysa portal urunu Logo'ya yazar ama fiyati
           yazamaz; kullanici urunu acar, fiyatini girer ve fiyatin gitmedigini
           ancak ilk siparis yanlis tutarla dustugunde ogrenir. Yarim
           yapilandirma, hic yapilandirmamaktan tehlikelidir. */
        if (string.IsNullOrWhiteSpace(ObjectServiceItemUrl)
            != string.IsNullOrWhiteSpace(ObjectServicePriceUrl))
        {
            yield return
                "Bridge:ObjectServiceItemUrl ve Bridge:ObjectServicePriceUrl birlikte tanımlanmalıdır; " +
                "yalnızca biri tanımlıyken katalog yazımı yarım çalışır.";
        }
    }

    /// <summary>Siparis yazimi yapilandirilmis mi?</summary>
    public bool CanWriteOrders => !string.IsNullOrWhiteSpace(ObjectServiceUrl);

    /// <summary>Katalog (kart + fiyat) yazimi yapilandirilmis mi?</summary>
    public bool CanWriteCatalog =>
        !string.IsNullOrWhiteSpace(ObjectServiceItemUrl)
        && !string.IsNullOrWhiteSpace(ObjectServicePriceUrl);

    /// <summary>Logo firma bazli tablo adi: <c>LG_001_ITEMS</c>.</summary>
    public string FirmTable(string name) => $"LG_{FirmNumber:D3}_{name}";

    /// <summary>Logo donem bazli tablo adi: <c>LG_001_01_ORFICHE</c>.</summary>
    public string PeriodTable(string name) => $"LG_{FirmNumber:D3}_{PeriodNumber:D2}_{name}";
}
