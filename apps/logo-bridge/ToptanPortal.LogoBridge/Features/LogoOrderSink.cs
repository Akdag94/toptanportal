using System.Net.Http.Json;

using ToptanPortal.LogoBridge.Configuration;

namespace ToptanPortal.LogoBridge.Features;

public sealed record SinkResult(string? LogoOrderNumber, int LogoReference, BridgeError? Error);

/// <summary>
/// Siparisi Logo'ya yazan uc. Bu arayuz, koprunun kurulumdan kuruluma degisen
/// TEK parcasidir: Tiger 3 Object Service, Go Wings REST ve j-Platform farkli
/// konusur. Geri kalan her sey (mTLS, imlecler, idempotency) ayni kalir.
/// </summary>
public interface ILogoOrderSink
{
    Task<SinkResult> SendAsync(BridgeOrderPush order, CancellationToken ct);

    /// <summary>
    /// Servise ULASILABILIYOR MU?
    ///
    /// Saglik ve tanilama uclari icindir. Yoklama SIPARIS YAZMAZ ve yazma
    /// yolunu denemez: saglik kontrolunun yan etkisi olan bir sistem, her
    /// izleme turunda bir fis acardi.
    /// </summary>
    Task<bool> ProbeAsync(CancellationToken ct);
}

/// <summary>
/// Logo Object Service adaptoru.
///
/// Servis adresi yapilandirilmamissa siparis SESSIZCE BASARILI SAYILMAZ:
/// kalici bir hata dondurulur. Yapilandirilmamis bir kopruden "tamam" yaniti
/// almak, portalde siparisi onaylanmis gostermek demektir - Logo'da hicbir sey
/// yokken.
/// </summary>
public sealed class ObjectServiceOrderSink : ILogoOrderSink
{
    private readonly HttpClient _http;
    private readonly BridgeOptions _options;
    private readonly ILogger<ObjectServiceOrderSink> _logger;

    public ObjectServiceOrderSink(
        HttpClient http,
        BridgeOptions options,
        ILogger<ObjectServiceOrderSink> logger)
    {
        _http = http;
        _options = options;
        _logger = logger;
    }

    /// <summary>
    /// Servisi yoklar. Yalnizca ULASILABILIRLIK sorulur; yanit kodunun ne
    /// oldugu onemli degildir - 404 donen bir servis de ayaktadir. Onemli olan
    /// baglantinin kurulup kurulmadigidir.
    /// </summary>
    public async Task<bool> ProbeAsync(CancellationToken ct)
    {
        if (!_options.CanWriteOrders)
        {
            return false;
        }

        try
        {
            using var istek = new HttpRequestMessage(HttpMethod.Head, _options.ObjectServiceUrl);
            using var yanit = await _http.SendAsync(istek, ct);
            return true;
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (TaskCanceledException)
        {
            // Zaman asimi da ulasilamama sayilir; cagiran taraf ayrimi kullanmaz.
            return false;
        }
    }

    public async Task<SinkResult> SendAsync(BridgeOrderPush order, CancellationToken ct)
    {
        if (!_options.CanWriteOrders)
        {
            return new SinkResult(null, 0, BridgeError.Validation(
                "Bridge:ObjectServiceUrl tanımlı değil; sipariş Logo'ya yazılamaz."));
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, _options.ObjectServiceUrl)
        {
            Content = JsonContent.Create(order),
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
                "Object Service {OrderNumber} siparişini reddetti: HTTP {Status} {Body}",
                order.OrderNumber,
                (int)response.StatusCode,
                govde);

            /* 5xx GECICI sayilmalidir; burada kalici hata uretmek, Logo'nun
               yeniden baslamasi sirasinda gelen siparisi olu isaretlerdi.
               Istisna firlatilir - kopru 502 doner ve portal tekrar dener. */
            if ((int)response.StatusCode >= 500)
            {
                throw new HttpRequestException(
                    $"Object Service geçici hata döndü: HTTP {(int)response.StatusCode}");
            }

            return new SinkResult(null, 0, BridgeError.Validation(
                $"Logo siparişi kabul etmedi: {govde}"));
        }

        var sonuc = await response.Content.ReadFromJsonAsync<ObjectServiceResponse>(ct);

        if (sonuc is null || string.IsNullOrWhiteSpace(sonuc.OrderNumber))
        {
            throw new HttpRequestException(
                "Object Service yanıtı sipariş numarası içermiyor; sonuç belirsiz.");
        }

        return new SinkResult(sonuc.OrderNumber, sonuc.Reference, null);
    }

    private sealed record ObjectServiceResponse(string OrderNumber, int Reference);
}
