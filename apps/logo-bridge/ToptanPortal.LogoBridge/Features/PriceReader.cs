using Microsoft.Data.SqlClient;

using ToptanPortal.LogoBridge.Configuration;
using ToptanPortal.LogoBridge.Data;

namespace ToptanPortal.LogoBridge.Features;

/// <summary>
/// Fiyat karti fark akisi (PRCLIST).
///
/// Fiyat kartlarinda <c>CAPIBLOCK_MODIFIEDDATE</c> bulunur, ancak imlec yine
/// LOGICALREF uzerinden ilerler: iki kart ayni saniyede degistiginde tarih
/// imleci onlardan birini atlar. Tarihi siralamaya, referansi imlece koymak
/// hem sirali hem atlamasiz bir akis verir.
///
/// Yalnizca SATIS fiyatlari (PTYPE = 2) tasinir. Alis fiyatlari portale hicbir
/// sekilde gonderilmez - bayinin toptancinin maliyetini gormesi, ticari olarak
/// kabul edilemez bir sizinti olurdu.
/// </summary>
public sealed class PriceReader
{
    private readonly LogoDatabase _db;
    private readonly BridgeOptions _options;

    public PriceReader(LogoDatabase db, BridgeOptions options)
    {
        _db = db;
        _options = options;
    }

    public async Task<PriceDeltaPage> ReadAsync(string? cursor, int? limit, CancellationToken ct)
    {
        var son = LogoDatabase.ParseCursor(cursor);
        var boyut = _db.ClampPageSize(limit);

        var sql = $"""
            SELECT TOP (@limit)
                   P.LOGICALREF AS Ref,
                   I.CODE       AS ItemCode,
                   P.PRELISTNO  AS PriceListNo,
                   U.CODE       AS UnitCode,
                   P.PRICE      AS Price,
                   P.CURRENCY   AS CurrencyNo,
                   P.BEGDATE    AS ValidFrom,
                   P.ENDDATE    AS ValidTo,
                   P.CAPIBLOCK_MODIFIEDDATE AS ChangedAt
            FROM   {_options.FirmTable("PRCLIST")} P
            JOIN   {_options.FirmTable("ITEMS")} I ON I.LOGICALREF = P.CARDREF
            LEFT JOIN {_options.FirmTable("UNITSETL")} U ON U.LOGICALREF = P.UOMREF
            WHERE  P.LOGICALREF > @cursor
              AND  P.PTYPE = 2
              AND  P.ACTIVE = 0
            ORDER BY P.LOGICALREF
            """;

        await using var connection = await _db.OpenAsync(ct);
        await using var command = new SqlCommand(sql, connection);
        /* Zaman asimi olmayan bir sorgu, Logo tarafinda kilitlenen tek bir
           tabloda koprunun tum baglanti havuzunu tuketir ve saglik ucu dahil
           hicbir istek yanit alamaz. */
        command.CommandTimeout = _options.CommandTimeoutSeconds;
        command.Parameters.Add("@limit", System.Data.SqlDbType.Int).Value = boyut;
        command.Parameters.Add("@cursor", System.Data.SqlDbType.BigInt).Value = son;

        var items = new List<PriceDeltaItem>(boyut);
        long sonRef = son;

        await using var reader = await command.ExecuteReaderAsync(ct);

        while (await reader.ReadAsync(ct))
        {
            sonRef = reader.GetInt32(0);

            items.Add(new PriceDeltaItem(
                LogoCode: reader.GetString(1),
                PriceListCode: reader.GetInt32(2).ToString(),
                UnitCode: reader.IsDBNull(3) ? string.Empty : reader.GetString(3),
                Price: reader.GetDecimal(4),
                Currency: CurrencyCode(reader.IsDBNull(5) ? 0 : reader.GetInt32(5)),
                ValidFrom: ReadDate(reader, 6),
                ValidTo: ReadDate(reader, 7),
                ChangedAt: ReadDate(reader, 8) ?? DateTime.UtcNow.ToString("O")));
        }

        var devamVar = items.Count == boyut;
        return new PriceDeltaPage(items, devamVar ? sonRef.ToString() : "0", devamVar);
    }

    private static string? ReadDate(SqlDataReader reader, int index) =>
        reader.IsDBNull(index) ? null : reader.GetDateTime(index).ToString("O");

    /// <summary>
    /// Logo doviz numarasini ISO koduna cevirir.
    ///
    /// 0 "yerel para birimi" demektir; Logo kurulumu Turkiye'de oldugu icin
    /// TRY'dir. Bilinmeyen numara TRY'ye DUSMEZ - yanlis para biriminde bir
    /// fiyat, yanlis tutarli bir siparistir. Bos deger doner ve bulut tarafi
    /// sozlesme dogrulamasinda satiri reddeder.
    /// </summary>
    private static string CurrencyCode(int logoCurrency) => logoCurrency switch
    {
        0 => "TRY",
        1 => "USD",
        20 => "EUR",
        17 => "GBP",
        _ => string.Empty,
    };
}
