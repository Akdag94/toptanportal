using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

using Microsoft.Extensions.Logging.Abstractions;

using ToptanPortal.LogoBridge.Configuration;
using ToptanPortal.LogoBridge.Data;
using ToptanPortal.LogoBridge.Features;
using ToptanPortal.LogoBridge.Security;

using Xunit;

namespace ToptanPortal.LogoBridge.Tests;

/// <summary>
/// Imlec cozumleme testleri.
///
/// Imlec, senkron akisinin BELLEGIDIR: bozuk yorumlanan bir imlec ya kayit
/// atlatir (yok-satma) ya da kanali kalici olarak kilitler. Ikisi de sessizdir.
/// </summary>
public sealed class CursorTests
{
    [Theory]
    [InlineData(null, 0L)]
    [InlineData("", 0L)]
    [InlineData("abc", 0L)]
    [InlineData("-5", 0L)]
    [InlineData("0", 0L)]
    [InlineData("4218", 4218L)]
    public void Bozuk_imlec_sifir_kabul_edilir(string? girdi, long beklenen)
    {
        /* Hata firlatmak, portalin bir kez bozuk imlec yazmasi halinde kanali
           KALICI olarak kilitlerdi; sifira donmek en fazla bir tur fazladan
           tarama demektir. */
        Assert.Equal(beklenen, LogoDatabase.ParseCursor(girdi));
    }

    [Fact]
    public void Sayfa_boyutu_yapilandirilan_ust_sinira_kirpilir()
    {
        var db = new LogoDatabase(new BridgeOptions { MaxPageSize = 500 });

        // Portalin istedigi boyut BAGLAYICI DEGILDIR: koprü, Logo veritabanini
        // portalin yukune karsi koruyan taraftir.
        Assert.Equal(500, db.ClampPageSize(100_000));
        Assert.Equal(1, db.ClampPageSize(0));
        Assert.Equal(200, db.ClampPageSize(null));
        Assert.Equal(120, db.ClampPageSize(120));
    }
}

/// <summary>
/// Istemci sertifikasi denetimi.
///
/// Zincir dogrulamasi Kestrel'dedir; burada sorulan soru farklidir: "zinciri
/// gecerli olan bu sertifika, BENIM izin verdigim sertifika mi?"
/// </summary>
public sealed class ClientCertificateValidatorTests
{
    private static X509Certificate2 Uret(string konu)
    {
        using var rsa = RSA.Create(2048);
        var istek = new CertificateRequest($"CN={konu}", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);

        return istek.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
    }

    private static string ParmakIzi(X509Certificate2 sertifika) =>
        Convert.ToHexString(SHA256.HashData(sertifika.RawData));

    private static ClientCertificateValidator Dogrulayici(params string[] parmakIzleri) =>
        new(
            new BridgeOptions { AllowedClientThumbprints = parmakIzleri },
            NullLogger<ClientCertificateValidator>.Instance);

    [Fact]
    public void Listedeki_sertifika_kabul_edilir()
    {
        using var sertifika = Uret("portal-bulut");
        var dogrulayici = Dogrulayici(ParmakIzi(sertifika));

        Assert.True(dogrulayici.IsAllowed(sertifika));
    }

    [Fact]
    public void Listede_olmayan_sertifika_reddedilir()
    {
        using var izinli = Uret("portal-bulut");
        using var yabanci = Uret("baska-istemci");

        // Ayni CA baska sertifikalar da imzalayabilir; "gecerli sertifika"
        // yetmez, LISTEDE olmasi gerekir.
        Assert.False(Dogrulayici(ParmakIzi(izinli)).IsAllowed(yabanci));
    }

    [Fact]
    public void Bos_liste_hicbir_sertifikayi_kabul_etmez()
    {
        using var sertifika = Uret("portal-bulut");

        /* Yapilandirma dogrulamasi bos listeyi zaten reddeder; buradaki test,
           o denetim atlansa bile davranisin "herkese acik" degil "kimseye
           kapali" olmasini kilitler. Guvenlik denetimlerinin varsayilani
           REDDETMEK olmalidir. */
        Assert.False(Dogrulayici().IsAllowed(sertifika));
    }

    [Fact]
    public void Iki_nokta_ile_yazilmis_parmak_izi_taninir()
    {
        using var sertifika = Uret("portal-bulut");
        var ham = ParmakIzi(sertifika);
        var noktali = string.Join(":", Enumerable.Range(0, ham.Length / 2).Select(i => ham.Substring(i * 2, 2)));

        Assert.True(Dogrulayici(noktali).IsAllowed(sertifika));
    }
}

/// <summary>
/// Hata sozlesmesi.
///
/// Bulut tarafi bu degerlere gore olayi OLU isaretler; geri donusu olmayan bir
/// karardir. Sebep kodunun degismesi, bulut tarafinda sessizce yanlis
/// siniflandirmaya yol acar.
/// </summary>
public sealed class BridgeErrorTests
{
    [Fact]
    public void Bilinmeyen_urun_kodu_hatanin_icinde_donulur()
    {
        var hata = BridgeError.UnknownProduct("KHV-001");

        // Operator eksigi Logo'da acacaktir; "doğrulama başarısız" mesaji onu
        // bos yere aratir.
        Assert.Equal("UNKNOWN_PRODUCT", hata.Reason);
        Assert.Equal("KHV-001", hata.OffendingCode);
        Assert.Contains("KHV-001", hata.Message);
    }

    [Fact]
    public void Sebep_kodlari_sozlesmedeki_degerlerdir()
    {
        Assert.Equal("UNKNOWN_COMPANY", BridgeError.UnknownCompany("120.01").Reason);
        Assert.Equal("UNKNOWN_WAREHOUSE", BridgeError.UnknownWarehouse("3").Reason);
        Assert.Equal("PERIOD_CLOSED", BridgeError.PeriodClosed(2).Reason);
        Assert.Equal("VALIDATION_FAILED", BridgeError.Validation("boş").Reason);
    }
}
