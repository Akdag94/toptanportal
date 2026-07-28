namespace ToptanPortal.LogoBridge.Configuration;

/// <summary>
/// Koprunun tum yapilandirmasi. Uygulama ACILIRKEN dogrulanir; eksik bir deger
/// varsa surec hicbir istek almadan durur.
///
/// Kopru sirket ici agda, gozetimsiz calisir. Yanlis yapilandirmayla ayakta
/// kalmasi, hic ayaga kalkmamasindan tehlikelidir: yanlis firma numarasiyla
/// acilan bir kopru, baska bir sirketin stok verisini portale tasir.
/// </summary>
public sealed class BridgeOptions
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
    }

    /// <summary>Logo firma bazli tablo adi: <c>LG_001_ITEMS</c>.</summary>
    public string FirmTable(string name) => $"LG_{FirmNumber:D3}_{name}";

    /// <summary>Logo donem bazli tablo adi: <c>LG_001_01_ORFICHE</c>.</summary>
    public string PeriodTable(string name) => $"LG_{FirmNumber:D3}_{PeriodNumber:D2}_{name}";
}
