using System.Reflection;

using ToptanPortal.LogoBridge.Configuration;
using ToptanPortal.LogoBridge.Data;

namespace ToptanPortal.LogoBridge.Features;

public static class Endpoints
{
    public static void MapBridgeEndpoints(this WebApplication app)
    {
        var grup = app.MapGroup("/bridge/v1");

        /* SAGLIK: kopru ayakta olmasi ile Logo'nun ayakta olmasi AYRI
           raporlanir. Ikisini tek bayrakta birlestiren bir yanit, gecici bir
           Logo bakiminda siparislerin olu isaretlenmesine yol acar. */
        grup.MapGet("/health", async (
            LogoDatabase db,
            BridgeOptions options,
            CancellationToken ct) =>
        {
            var veritabani = await db.IsReachableAsync(ct);
            var surum = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0";

            var durum = veritabani ? "HEALTHY" : "DEGRADED";

            return Results.Ok(new BridgeHealth(
                Status: durum,
                Version: surum,
                LogoServiceUp: veritabani,
                DatabaseUp: veritabani,
                CompanyNumber: options.FirmNumber,
                PeriodNumber: options.PeriodNumber,
                CheckedAt: DateTime.UtcNow.ToString("O"),
                Message: veritabani ? null : "Logo veritabanına erişilemiyor."));
        });

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
    }
}
