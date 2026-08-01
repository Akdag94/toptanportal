using Microsoft.Data.SqlClient;

using ToptanPortal.LogoBridge.Configuration;
using ToptanPortal.LogoBridge.Data;

namespace ToptanPortal.LogoBridge.Features;

/// <summary>
/// Cari hareket fark akisi (CLFLINE).
///
/// Cari hareketler EKLENIR, degistirilmez: muhasebe bir hareketi duzeltmek
/// icin ters kayit atar. Bu yuzden LOGICALREF uzerinde ilerleyen imlec burada
/// tam dogru davranistir - stok ve fiyatta oldugu gibi donup basa gelmeye
/// gerek yoktur, akis ileri dogru akar.
///
/// SIGN alani yonu belirler: 0 borc, 1 alacak. Tutar her zaman pozitiftir;
/// isareti bu alandan okumak, negatif tutar tasimaktan daha az hataya acik.
/// </summary>
public sealed class AccountReader
{
    private readonly LogoDatabase _db;
    private readonly BridgeOptions _options;

    public AccountReader(LogoDatabase db, BridgeOptions options)
    {
        _db = db;
        _options = options;
    }

    public async Task<AccountDeltaPage> ReadAsync(string? cursor, int? limit, CancellationToken ct)
    {
        var son = LogoDatabase.ParseCursor(cursor);
        var boyut = _db.ClampPageSize(limit);

        var sql = $"""
            SELECT TOP (@limit)
                   L.LOGICALREF  AS Ref,
                   C.CODE        AS CariCode,
                   L.TRANNO      AS DocumentNumber,
                   L.TRCODE      AS DocumentType,
                   L.DATE_       AS EntryDate,
                   L.DUEDATE     AS DueDate,
                   L.AMOUNT      AS Amount,
                   L.SIGN        AS Sign,
                   L.LINEEXP     AS Description
            FROM   {_options.PeriodTable("CLFLINE")} L
            JOIN   {_options.FirmTable("CLCARD")} C ON C.LOGICALREF = L.CLIENTREF
            WHERE  L.LOGICALREF > @cursor
              AND  L.CANCELLED = 0
            ORDER BY L.LOGICALREF
            """;

        await using var connection = await _db.OpenAsync(ct);
        await using var command = new SqlCommand(sql, connection);
        /* Zaman asimi olmayan bir sorgu, Logo tarafinda kilitlenen tek bir
           tabloda koprunun tum baglanti havuzunu tuketir ve saglik ucu dahil
           hicbir istek yanit alamaz. */
        command.CommandTimeout = _options.CommandTimeoutSeconds;
        command.Parameters.Add("@limit", System.Data.SqlDbType.Int).Value = boyut;
        command.Parameters.Add("@cursor", System.Data.SqlDbType.BigInt).Value = son;

        var items = new List<AccountDeltaItem>(boyut);
        long sonRef = son;

        await using var reader = await command.ExecuteReaderAsync(ct);

        while (await reader.ReadAsync(ct))
        {
            var reference = reader.GetInt32(0);
            sonRef = reference;

            var tutar = reader.GetDecimal(6);
            var alacak = reader.GetInt16(7) == 1;
            var tarih = reader.GetDateTime(4);

            items.Add(new AccountDeltaItem(
                LogoCode: reader.GetString(1),
                FicheRef: reference,
                DocumentNumber: reader.IsDBNull(2) ? string.Empty : reader.GetString(2),
                DocumentType: reader.GetInt16(3),
                EntryDate: tarih.ToString("O"),
                DueDate: reader.IsDBNull(5) ? null : reader.GetDateTime(5).ToString("O"),
                Debit: alacak ? 0m : tutar,
                Credit: alacak ? tutar : 0m,
                Description: reader.IsDBNull(8) ? null : reader.GetString(8),
                ChangedAt: tarih.ToString("O")));
        }

        var devamVar = items.Count == boyut;

        /* Sona gelindiginde imlec KORUNUR: yeni hareketler bu referansin
           uzerine eklenir. Sifirlamak, tum gecmisi her turda yeniden okumak
           olurdu. */
        return new AccountDeltaPage(items, sonRef.ToString(), devamVar);
    }
}
