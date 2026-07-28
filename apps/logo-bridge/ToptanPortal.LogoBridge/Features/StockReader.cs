using Microsoft.Data.SqlClient;

using ToptanPortal.LogoBridge.Configuration;
using ToptanPortal.LogoBridge.Data;

namespace ToptanPortal.LogoBridge.Features;

/// <summary>
/// Stok fark akisi.
///
/// LOGO'DA STOK TOPLAMLARI ICIN DEGISIKLIK DAMGASI YOKTUR. Fatura satiri veya
/// fis eklendiginde toplam yeniden hesaplanir ama "en son ne zaman degisti"
/// bilgisi tutulmaz. Bu yuzden akis, LOGICALREF uzerinde DONEN BIR TARAMADIR:
/// sayfa sayfa ilerlenir, sona gelindiginde imlec sifirlanip basa donulur.
///
/// Sonucu: her stok satiri, tarama periyodu boyunca en az bir kez tazelenir.
/// "Degisti mi" sorusunu soramadigimiz icin "hepsini dolas" cevabini veririz;
/// alternatifi, degisikligi kaciran ve yok-satmaya yol acan bir akistir.
///
/// TABLO/VIEW ADLARI Logo surumune gore degisebilir (Tiger 3, Go Wings,
/// Enterprise). Kurulumda dogrulanmalidir.
/// </summary>
public sealed class StockReader
{
    private readonly LogoDatabase _db;
    private readonly BridgeOptions _options;

    public StockReader(LogoDatabase db, BridgeOptions options)
    {
        _db = db;
        _options = options;
    }

    public async Task<StockDeltaPage> ReadAsync(string? cursor, int? limit, CancellationToken ct)
    {
        var son = LogoDatabase.ParseCursor(cursor);
        var boyut = _db.ClampPageSize(limit);

        var sql = $"""
            SELECT TOP (@limit)
                   T.LOGICALREF   AS Ref,
                   I.CODE         AS ItemCode,
                   T.INVENNO      AS WarehouseNo,
                   T.ONHAND       AS OnHand,
                   T.ORDERRESERVED AS Allocated,
                   U.CODE         AS UnitCode
            FROM   {_options.PeriodTable("STINVTOT")} T
            JOIN   {_options.FirmTable("ITEMS")} I ON I.LOGICALREF = T.STOCKREF
            LEFT JOIN {_options.FirmTable("UNITSETL")} U ON U.LOGICALREF = I.UNITSETREF AND U.MAINUNIT = 1
            WHERE  T.LOGICALREF > @cursor
              AND  T.INVENNO >= 0
            ORDER BY T.LOGICALREF
            """;

        await using var connection = await _db.OpenAsync(ct);
        await using var command = new SqlCommand(sql, connection);
        command.Parameters.Add("@limit", System.Data.SqlDbType.Int).Value = boyut;
        command.Parameters.Add("@cursor", System.Data.SqlDbType.BigInt).Value = son;

        var items = new List<StockDeltaItem>(boyut);
        long sonRef = son;
        var simdi = DateTime.UtcNow.ToString("O");

        await using var reader = await command.ExecuteReaderAsync(ct);

        while (await reader.ReadAsync(ct))
        {
            sonRef = reader.GetInt32(0);

            items.Add(new StockDeltaItem(
                LogoCode: reader.GetString(1),
                WarehouseCode: reader.GetInt32(2).ToString(),
                OnHand: reader.GetDecimal(3),
                Allocated: reader.IsDBNull(4) ? 0m : reader.GetDecimal(4),
                UnitCode: reader.IsDBNull(5) ? string.Empty : reader.GetString(5),
                /* Degisiklik zamani bilinmiyor; okuma zamani yazilir. Portal bu
                   alani yalnizca gosterim icin kullanir, imlec olarak DEGIL. */
                ChangedAt: simdi));
        }

        var devamVar = items.Count == boyut;

        /* Tarama bittiginde imlec sifirlanir: bir sonraki tur bastan baslar ve
           degisen kayitlar boylece yakalanir. */
        return new StockDeltaPage(items, devamVar ? sonRef.ToString() : "0", devamVar);
    }
}
