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
    private readonly string? _endpoint;
    private readonly ILogger<ObjectServiceOrderSink> _logger;

    public ObjectServiceOrderSink(
        HttpClient http,
        IConfiguration configuration,
        ILogger<ObjectServiceOrderSink> logger)
    {
        _http = http;
        _endpoint = configuration[$"{BridgeOptions.SectionName}:ObjectServiceUrl"];
        _logger = logger;
    }

    public async Task<SinkResult> SendAsync(BridgeOrderPush order, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_endpoint))
        {
            return new SinkResult(null, 0, BridgeError.Validation(
                "Bridge:ObjectServiceUrl tanımlı değil; sipariş Logo'ya yazılamaz."));
        }

        using var response = await _http.PostAsJsonAsync(_endpoint, order, ct);

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
