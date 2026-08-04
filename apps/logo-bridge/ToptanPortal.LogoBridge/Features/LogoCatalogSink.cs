using System.Net.Http.Json;

using ToptanPortal.LogoBridge.Configuration;

namespace ToptanPortal.LogoBridge.Features;

public sealed record ItemSinkResult(int LogoItemRef, BridgeError? Error);

public sealed record PriceSinkResult(int LogoPriceRef, BridgeError? Error);

/// <summary>
/// Stok karti ve fiyat kartini Logo'ya yazan uc.
///
/// <see cref="ILogoOrderSink"/> ile ayni gerekce: ITEMS ve PRCLIST tablolarina
/// dogrudan INSERT yapilmaz. Logo stok karti tek bir satir degildir - birim
/// seti, birim cevrimleri, muhasebe baglantisi ve KDV tanimi ayri tablolardadir
/// ve aralarindaki tutarlilik Logo'nun kendi mantigiyla kurulur. Elle yazilan
/// bir kart Logo ekraninda gorunur, siparis fisine secilebilir ve donem sonunda
/// tutmaz.
/// </summary>
public interface ILogoCatalogSink
{
    Task<ItemSinkResult> WriteItemAsync(BridgeItemPush item, CancellationToken ct);

    Task<PriceSinkResult> WritePriceAsync(BridgePricePush price, CancellationToken ct);

    /// <summary>
    /// Katalog yazim uclarina ULASILABILIYOR MU?
    ///
    /// Yoklama KART ACMAZ ve fiyat yazmaz: yan etkisi olan bir saglik kontrolu,
    /// her izleme turunda katalogda bir satir birakirdi.
    /// </summary>
    Task<bool> ProbeAsync(CancellationToken ct);
}

/// <summary>
/// Logo Object Service katalog adaptoru.
///
/// Adres yapilandirilmamissa yazim SESSIZCE BASARILI SAYILMAZ; kalici hata
/// doner. "Tamam" yaniti almak, portalde urunu Logo'ya gecmis gostermek
/// demektir - Logo'da hicbir sey yokken, ve o urun katalogda yayina alinir.
/// </summary>
public sealed class ObjectServiceCatalogSink : ILogoCatalogSink
{
    private readonly HttpClient _http;
    private readonly BridgeOptions _options;
    private readonly ILogger<ObjectServiceCatalogSink> _logger;

    public ObjectServiceCatalogSink(
        HttpClient http,
        BridgeOptions options,
        ILogger<ObjectServiceCatalogSink> logger)
    {
        _http = http;
        _options = options;
        _logger = logger;
    }

    public async Task<bool> ProbeAsync(CancellationToken ct)
    {
        if (!_options.CanWriteCatalog)
        {
            return false;
        }

        try
        {
            using var istek = new HttpRequestMessage(HttpMethod.Head, _options.ObjectServiceItemUrl);
            using var yanit = await _http.SendAsync(istek, ct);
            /* Yanit KODU onemli degildir: 404 donen bir servis de ayaktadir.
               Sorulan tek sey baglantinin kurulup kurulmadigidir. */
            return true;
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (TaskCanceledException)
        {
            return false;
        }
    }

    public Task<ItemSinkResult> WriteItemAsync(BridgeItemPush item, CancellationToken ct) =>
        WriteAsync(
            _options.ObjectServiceItemUrl,
            item,
            item.LogoItemCode,
            "stok kartı",
            (referans) => new ItemSinkResult(referans, null),
            (hata) => new ItemSinkResult(0, hata),
            ct);

    public Task<PriceSinkResult> WritePriceAsync(BridgePricePush price, CancellationToken ct) =>
        WriteAsync(
            _options.ObjectServicePriceUrl,
            price,
            $"{price.LogoItemCode}/{price.PriceListCode}",
            "fiyat kartı",
            (referans) => new PriceSinkResult(referans, null),
            (hata) => new PriceSinkResult(0, hata),
            ct);

    /// <summary>
    /// Iki yazimin ortak govdesi. Ayrimlari yalnizca adres, etiket ve sonuc
    /// tipidir; hata siniflandirmasi ikisi icin de AYNI olmak zorundadir -
    /// farklilasirsa bir yazim kalici sayilirken otekinin gecici sayilmasi gibi
    /// bir tutarsizlik dogar ve o tutarsizlik ancak sahada gorunur.
    /// </summary>
    private async Task<TResult> WriteAsync<TBody, TResult>(
        string? url,
        TBody body,
        string tanim,
        string etiket,
        Func<int, TResult> basarili,
        Func<BridgeError, TResult> basarisiz,
        CancellationToken ct)
    {
        if (!_options.CanWriteCatalog || string.IsNullOrWhiteSpace(url))
        {
            return basarisiz(BridgeError.Validation(
                "Bridge:ObjectServiceItemUrl / ObjectServicePriceUrl tanımlı değil; " +
                "katalog Logo'ya yazılamaz."));
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = JsonContent.Create(body),
        };

        if (!string.IsNullOrWhiteSpace(_options.ObjectServiceApiKey))
        {
            request.Headers.TryAddWithoutValidation("X-Api-Key", _options.ObjectServiceApiKey);
        }

        using var response = await _http.SendAsync(request, ct);

        if (!response.IsSuccessStatusCode)
        {
            var govde = await response.Content.ReadAsStringAsync(ct);

            _logger.LogError(
                "Object Service {Etiket} yazımını reddetti ({Tanim}): HTTP {Status} {Body}",
                etiket,
                tanim,
                (int)response.StatusCode,
                govde);

            /* 5xx GECICIDIR. Burada kalici hata uretmek, Logo yeniden
               baslarken gonderilen bir fiyat degisikligini olu isaretlerdi ve
               o fiyat bir daha hic denenmezdi. */
            if ((int)response.StatusCode >= 500)
            {
                throw new HttpRequestException(
                    $"Object Service geçici hata döndü: HTTP {(int)response.StatusCode}");
            }

            return basarisiz(BridgeError.Validation($"Logo {etiket} yazımını kabul etmedi: {govde}"));
        }

        var sonuc = await response.Content.ReadFromJsonAsync<ObjectServiceCatalogResponse>(ct);

        if (sonuc is null || sonuc.Reference <= 0)
        {
            /* Referanssiz bir "tamam" yaniti, yazimin gerceklestigini
               DOGRULAMAZ. Basarili saymak, Logo'da olmayan bir karti portalde
               "Logo ile eşit" gostermek olurdu; istisna firlatilir ve portal
               tekrar dener. */
            throw new HttpRequestException(
                $"Object Service yanıtı {etiket} referansı içermiyor; sonuç belirsiz.");
        }

        return basarili(sonuc.Reference);
    }

    private sealed record ObjectServiceCatalogResponse(int Reference);
}
