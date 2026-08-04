using System.Reflection;

using ToptanPortal.LogoBridge.Configuration;
using ToptanPortal.LogoBridge.Data;

namespace ToptanPortal.LogoBridge.Features;

public static class Endpoints
{
    public static void MapBridgeEndpoints(this WebApplication app)
    {
        var grup = app.MapGroup("/bridge/v1");

        /* SAGLIK: koprunun ayakta olmasi, Logo VERITABANININ ayakta olmasi ve
           Logo SERVISININ ayakta olmasi UC AYRI seydir ve ayri raporlanir.
           Ucunu tek bayrakta birlestiren bir yanit, gecici bir Logo bakiminda
           siparislerin olu isaretlenmesine yol acar; okumanin calisip yazmanin
           durdugu durumu ise hic gostermez. */
        grup.MapGet("/health", async (
            LogoDatabase db,
            ILogoOrderSink sink,
            BridgeOptions options,
            CancellationToken ct) =>
        {
            var veritabani = await db.IsReachableAsync(ct);
            var servis = await sink.ProbeAsync(ct);
            var surum = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0";

            /* Veritabani dustuyse kopru islevsizdir; servis dustuyse yalnizca
               YAZMA durur, okuma akislari calismaya devam eder. Ikisi ayni
               agirlikta degildir. */
            var durum = veritabani ? (servis ? "HEALTHY" : "DEGRADED") : "DOWN";

            var mesaj = !veritabani
                ? "Logo veritabanına erişilemiyor."
                : servis
                    ? null
                    : options.CanWriteOrders
                        ? "Logo Object Service'e ulaşılamıyor; sipariş yazımı duraklamış durumda."
                        : "Sipariş yazımı yapılandırılmamış; yalnızca okuma akışları çalışıyor.";

            return Results.Ok(new BridgeHealth(
                Status: durum,
                Version: surum,
                LogoServiceUp: servis,
                DatabaseUp: veritabani,
                CompanyNumber: options.FirmNumber,
                PeriodNumber: options.PeriodNumber,
                CheckedAt: DateTime.UtcNow.ToString("O"),
                Message: mesaj));
        });

        /* TANILAMA: kurulumda calistirilir; tablo, kolon ve donem eksiklerini
           insan okuyabilir bicimde verir. Saglik ucundan ayridir cunku her
           tablo icin ayri sorgu calistirir ve her bes dakikada bir yapilacak
           bir is degildir. */
        grup.MapGet("/diagnostics", (InstallationDiagnostics diagnostics, CancellationToken ct) =>
            diagnostics.RunAsync(ct));

        grup.MapGet("/stock", (StockReader reader, string? cursor, int? limit, CancellationToken ct) =>
            reader.ReadAsync(cursor, limit, ct));

        grup.MapGet("/prices", (PriceReader reader, string? cursor, int? limit, CancellationToken ct) =>
            reader.ReadAsync(cursor, limit, ct));

        grup.MapGet("/accounts", (AccountReader reader, string? cursor, int? limit, CancellationToken ct) =>
            reader.ReadAsync(cursor, limit, ct));

        /* SIPARIS: 422 kalici hatadir (portal olayi olu isaretler), 5xx
           gecicidir (portal tekrar dener). Bu ayrimi burada dogru vermek,
           bulut tarafindaki tum kuyruk davranisini belirler. */
        grup.MapPost("/orders", async (
            BridgeOrderPush order,
            OrderWriter writer,
            CancellationToken ct) =>
        {
            var (sonuc, hata) = await writer.WriteAsync(order, ct);

            return hata is not null
                ? Results.UnprocessableEntity(hata)
                : Results.Ok(sonuc);
        });

        /* KATALOG YAZIMI: portalde acilan/duzenlenen kart ve fiyat.
           Siparis ucuyla ayni hata sozlesmesini kullanir - 422 kalici, 5xx
           gecici. Iki yazim yolunun ayni siniflandirmayi paylasmasi sarttir:
           farklilasirsa, ayni ag hatasi bir yolda kuyrukta beklerken otekinde
           olu isaretlenir. */
        grup.MapPost("/items", async (
            BridgeItemPush item,
            CatalogWriter writer,
            CancellationToken ct) =>
        {
            var (sonuc, hata) = await writer.WriteItemAsync(item, ct);

            return hata is not null
                ? Results.UnprocessableEntity(hata)
                : Results.Ok(sonuc);
        });

        grup.MapPost("/prices", async (
            BridgePricePush price,
            CatalogWriter writer,
            CancellationToken ct) =>
        {
            var (sonuc, hata) = await writer.WritePriceAsync(price, ct);

            return hata is not null
                ? Results.UnprocessableEntity(hata)
                : Results.Ok(sonuc);
        });
    }
}
