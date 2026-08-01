using ToptanPortal.LogoBridge.Configuration;

using Xunit;

namespace ToptanPortal.LogoBridge.Tests;

/// <summary>
/// Yapilandirma dogrulamasinin testleri.
///
/// Bu testlerin isi bir tercihi kilitlemektir: KOPRU YANLIS YAPILANDIRMAYLA
/// ACILMAZ. Sirket ici agda gozetimsiz calisan bir servis icin "acildi ama
/// yanlis calisiyor", "hic acilmadi"dan tehlikelidir - yanlis firma
/// numarasiyla acilan bir kopru, baska bir sirketin stok verisini portale
/// tasir ve bunu kimse fark etmez.
/// </summary>
public sealed class BridgeOptionsTests
{
    private const string GecerliParmakIzi =
        "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90";

    private static BridgeOptions Gecerli() => new()
    {
        ConnectionString = "Server=.;Database=LOGO;Trusted_Connection=True;",
        FirmNumber = 1,
        PeriodNumber = 1,
        AllowedClientThumbprints = [GecerliParmakIzi],
    };

    [Fact]
    public void Gecerli_yapilandirma_hata_uretmez()
    {
        Assert.Empty(Gecerli().Validate());
    }

    [Fact]
    public void Baglanti_dizesi_zorunludur()
    {
        var options = Gecerli() with { ConnectionString = "  " };

        Assert.Contains(options.Validate(), h => h.Contains("ConnectionString"));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1000)]
    public void Firma_numarasi_aralik_disinda_reddedilir(int firma)
    {
        var options = Gecerli() with { FirmNumber = firma };

        Assert.Contains(options.Validate(), h => h.Contains("FirmNumber"));
    }

    [Fact]
    public void Bos_parmak_izi_listesi_reddedilir()
    {
        // Bos liste, gecerli sertifika tasiyan HERKESIN koprüye baglanabilmesi
        // demektir; ayni CA baska sertifikalar da imzalayabilir.
        var options = Gecerli() with { AllowedClientThumbprints = [] };

        Assert.Contains(options.Validate(), h => h.Contains("AllowedClientThumbprints"));
    }

    [Fact]
    public void Sha1_parmak_izi_yapistirildiginda_uyarir()
    {
        /* 40 karakterlik SHA-1 parmak izi, Windows sertifika ekranindan
           kopyalanan degerdir ve sik yapilan bir hatadir. Kabul edilseydi
           liste hicbir sertifikayla eslesmez, hata ancak ilk istekte
           "sertifika kabul edilmedi" diye gorunurdu. */
        var options = Gecerli() with
        {
            AllowedClientThumbprints = ["A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4"],
        };

        Assert.Contains(options.Validate(), h => h.Contains("SHA-256"));
    }

    [Fact]
    public void Parmak_izinde_iki_nokta_ve_bosluk_kabul_edilir()
    {
        // Sertifika araclari parmak izini "A1:B2:C3..." veya bosluklu verir;
        // kullaniciyi bicimi elle temizlemeye zorlamak gereksiz bir engeldir.
        var options = Gecerli() with
        {
            AllowedClientThumbprints = [string.Join(":", Bolumle(GecerliParmakIzi))],
        };

        Assert.Empty(options.Validate());
    }

    [Fact]
    public void Bozuk_object_service_adresi_reddedilir()
    {
        // Yazim hatasi tasiyan bir adres, ilk siparis gelene kadar sessiz kalir
        // ve o siparis "Logo kabul etmedi" diye olu isaretlenir - oysa Logo o
        // istegi hic gormemistir.
        var options = Gecerli() with { ObjectServiceUrl = "logo-sunucu:8080/orders" };

        Assert.Contains(options.Validate(), h => h.Contains("ObjectServiceUrl"));
    }

    [Fact]
    public void Object_service_tanimsizken_siparis_yazimi_kapalidir()
    {
        Assert.False(Gecerli().CanWriteOrders);
        Assert.True((Gecerli() with { ObjectServiceUrl = "http://logo:8080/orders" }).CanWriteOrders);
    }

    [Fact]
    public void Sifir_zaman_asimi_reddedilir()
    {
        // Sinirsiz bekleyen bir sorgu, Logo tarafinda kilitlenen tek bir
        // tabloda koprunun tum baglanti havuzunu tuketir.
        var options = Gecerli() with { CommandTimeoutSeconds = 0 };

        Assert.Contains(options.Validate(), h => h.Contains("CommandTimeoutSeconds"));
    }

    [Fact]
    public void Tablo_adlari_firma_ve_donem_numarasindan_uretilir()
    {
        // Tablo adi parametre OLAMAZ; firma ve donem numarasi ada gomulur.
        // Bu yuzden sayilar acilista aralik denetiminden gecer ve ad serbest
        // metinden kurulmaz - aksi halde SQL enjeksiyonuna dogrudan davetiye.
        var options = Gecerli() with { FirmNumber = 7, PeriodNumber = 3 };

        Assert.Equal("LG_007_ITEMS", options.FirmTable("ITEMS"));
        Assert.Equal("LG_007_03_ORFICHE", options.PeriodTable("ORFICHE"));
    }

    private static IEnumerable<string> Bolumle(string deger)
    {
        for (var i = 0; i < deger.Length; i += 2)
        {
            yield return deger.Substring(i, 2);
        }
    }
}
