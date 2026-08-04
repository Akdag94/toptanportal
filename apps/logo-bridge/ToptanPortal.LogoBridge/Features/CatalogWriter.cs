using Microsoft.Data.SqlClient;

using ToptanPortal.LogoBridge.Configuration;
using ToptanPortal.LogoBridge.Data;

namespace ToptanPortal.LogoBridge.Features;

/// <summary>
/// Stok karti ve fiyat yazimi.
///
/// Yazmanin kendisi Logo'nun servis katmanina devredilir
/// (<see cref="ILogoCatalogSink"/>); bu sinifin isi, yazmadan ONCE karar
/// vermektir:
///
///   * Kod Logo'da VAR MI - yani bu cagri kart aciyor mu, guncelliyor mu?
///     Cevap `created` bayragina gider ve portal tarafinda "yeni kart acildi"
///     ile "var olan kart guncellendi" ayrimini kurar.
///   * Kod Logo'da BASKA TURDE bir kartta kullaniliyor mu? Ustune yazmak,
///     muhasebenin baska amacla actigi bir karti portal urunune cevirirdi.
///   * Gonderilen birimler Logo'da TANIMLI mi? Tanimsiz birimle acilan bir
///     kart, siparis fisinde birim secilemedigi icin kullanilamaz - ve bu,
///     kart acildiktan gunler sonra ilk sipariste anlasilir.
///
/// Denetimleri Object Service'e birakmak mumkundu; birakmamanin sebebi HATA
/// MESAJIDIR. Object Service reddi cogu kurulumda "işlem başarısız" dizesidir;
/// operator neyi duzeltecegini bilemez. Burada uretilen hata, eksik olan seyi
/// ISMIYLE soyler.
/// </summary>
public sealed class CatalogWriter
{
    /// <summary>
    /// Portalin uzerine yazabilecegi Logo kart turleri (ITEMS.CARDTYPE).
    ///
    /// Ticari mal, karma koli, depozitolu ve uretim kartlari. Sabit kiymet ve
    /// benzeri kartlar disaridadir: portal onlari acmaz, dolayisiyla ustune de
    /// yazmamalidir.
    /// </summary>
    private static readonly int[] YazilabilirKartTurleri = [1, 2, 3, 10, 11, 12, 13];

    private readonly LogoDatabase _db;
    private readonly BridgeOptions _options;
    private readonly ILogoCatalogSink _sink;
    private readonly ILogger<CatalogWriter> _logger;

    public CatalogWriter(
        LogoDatabase db,
        BridgeOptions options,
        ILogoCatalogSink sink,
        ILogger<CatalogWriter> logger)
    {
        _db = db;
        _options = options;
        _sink = sink;
        _logger = logger;
    }

    // -----------------------------------------------------------------------
    // Stok karti
    // -----------------------------------------------------------------------

    public async Task<(BridgeItemResult? Result, BridgeError? Error)> WriteItemAsync(
        BridgeItemPush item,
        CancellationToken ct)
    {
        if (item.Units.Count == 0)
        {
            return (null, BridgeError.Validation("Stok kartı birimsiz yazılamaz."));
        }

        if (item.Units.Count(birim => birim.IsBaseUnit) != 1)
        {
            /* Ana birimi olmayan ya da iki ana birimi olan bir kart, stok
               miktarinin hangi birimde tutuldugunu belirsiz birakir. Logo bunu
               kabul etse bile portal etmemeli: belirsiz birim, 12 kat yanlis
               sevkiyattir. */
            return (null, BridgeError.Validation(
                "Stok kartında tam olarak bir ana birim bulunmalıdır."));
        }

        await using var connection = await _db.OpenAsync(ct);

        var mevcut = await FindItemAsync(connection, item.LogoItemCode, ct);

        if (mevcut is not null && !YazilabilirKartTurleri.Contains(mevcut.CardType))
        {
            return (null, BridgeError.DuplicateItemCode(item.LogoItemCode));
        }

        foreach (var birim in item.Units)
        {
            if (!await UnitExistsAsync(connection, birim.Code, ct))
            {
                return (null, BridgeError.UnknownUnit(birim.Code));
            }
        }

        var sonuc = await _sink.WriteItemAsync(item, ct);

        if (sonuc.Error is not null)
        {
            return (null, sonuc.Error);
        }

        _logger.LogInformation(
            "{Code} stok kartı Logo'ya yazıldı ({Islem}).",
            item.LogoItemCode,
            mevcut is null ? "açıldı" : "güncellendi");

        return (new BridgeItemResult(
            item.LogoItemCode,
            sonuc.LogoItemRef,
            Created: mevcut is null,
            WrittenAt: DateTime.UtcNow.ToString("O")), null);
    }

    // -----------------------------------------------------------------------
    // Fiyat karti
    // -----------------------------------------------------------------------

    public async Task<(BridgePriceResult? Result, BridgeError? Error)> WritePriceAsync(
        BridgePricePush price,
        CancellationToken ct)
    {
        if (price.Price < 0)
        {
            return (null, BridgeError.Validation("Negatif birim fiyat yazılamaz."));
        }

        /* Fiyat listesi numarasi Logo'da tam sayidir. Sayiya cevrilemeyen bir
           deger, sorguya parametre olarak gectiginde sessizce "eslesme yok"
           uretir ve fiyat hicbir yere yazilmadigi halde islem basarili
           gorunur. */
        if (!int.TryParse(price.PriceListCode, out var listeNo) || listeNo is < 1 or > 9999)
        {
            return (null, BridgeError.UnknownPriceList(price.PriceListCode));
        }

        await using var connection = await _db.OpenAsync(ct);

        var urun = await FindItemAsync(connection, price.LogoItemCode, ct);

        if (urun is null)
        {
            /* Fiyat, kartindan once yazilamaz. Bu KALICI bir hata degil gibi
               gorunur (kart birazdan acilabilir) ama oyledir: portal karti once
               yazar, fiyati sonra kuyruga alir. Kart yoksa yazim basarisiz
               olmustur ve fiyatin tek basina denenmesi ayni sonucu verir. */
            return (null, BridgeError.UnknownProduct(price.LogoItemCode));
        }

        if (price.UnitCode is not null && !await UnitExistsAsync(connection, price.UnitCode, ct))
        {
            return (null, BridgeError.UnknownUnit(price.UnitCode));
        }

        var mevcutRef = await FindPriceAsync(connection, urun.Reference, listeNo, price.UnitCode, ct);

        var sonuc = await _sink.WritePriceAsync(price, ct);

        if (sonuc.Error is not null)
        {
            return (null, sonuc.Error);
        }

        return (new BridgePriceResult(
            price.LogoItemCode,
            price.PriceListCode,
            sonuc.LogoPriceRef,
            Created: mevcutRef is null,
            WrittenAt: DateTime.UtcNow.ToString("O")), null);
    }

    // -----------------------------------------------------------------------
    // Logo sorgulari
    // -----------------------------------------------------------------------

    private sealed record LogoItem(int Reference, int CardType);

    private async Task<LogoItem?> FindItemAsync(
        SqlConnection connection,
        string code,
        CancellationToken ct)
    {
        var sql = $"""
            SELECT TOP 1 LOGICALREF, CARDTYPE
            FROM   {_options.FirmTable("ITEMS")}
            WHERE  CODE = @code
            """;

        await using var command = new SqlCommand(sql, connection);
        command.CommandTimeout = _options.CommandTimeoutSeconds;
        command.Parameters.Add("@code", System.Data.SqlDbType.NVarChar, 64).Value = code;

        await using var reader = await command.ExecuteReaderAsync(ct);

        return await reader.ReadAsync(ct)
            ? new LogoItem(reader.GetInt32(0), reader.GetInt32(1))
            : null;
    }

    private async Task<bool> UnitExistsAsync(
        SqlConnection connection,
        string unitCode,
        CancellationToken ct)
    {
        var sql = $"""
            SELECT TOP 1 1
            FROM   {_options.FirmTable("UNITSETL")}
            WHERE  CODE = @code
            """;

        await using var command = new SqlCommand(sql, connection);
        command.CommandTimeout = _options.CommandTimeoutSeconds;
        command.Parameters.Add("@code", System.Data.SqlDbType.NVarChar, 64).Value = unitCode;

        return await command.ExecuteScalarAsync(ct) is not null;
    }

    /// <summary>
    /// Ayni kart/liste/birim icin fiyat satiri VAR MI?
    ///
    /// Yalnizca <c>created</c> bayragini belirler; yazimin kendisi Object
    /// Service tarafinda ustune yazma (upsert) olarak yapilir. Bu ayrim
    /// onemlidir: portal "yeni fiyat tanimlandi" ile "fiyat degistirildi"
    /// arasindaki farki denetim kaydina yazar.
    /// </summary>
    private async Task<int?> FindPriceAsync(
        SqlConnection connection,
        int itemReference,
        int priceListNo,
        string? unitCode,
        CancellationToken ct)
    {
        var sql = $"""
            SELECT TOP 1 P.LOGICALREF
            FROM   {_options.FirmTable("PRCLIST")} P
            LEFT JOIN {_options.FirmTable("UNITSETL")} U ON U.LOGICALREF = P.UOMREF
            WHERE  P.CARDREF = @item
              AND  P.PRELISTNO = @list
              AND  P.PTYPE = 2
              AND  (@unit IS NULL AND P.UOMREF = 0 OR U.CODE = @unit)
            """;

        await using var command = new SqlCommand(sql, connection);
        command.CommandTimeout = _options.CommandTimeoutSeconds;
        command.Parameters.Add("@item", System.Data.SqlDbType.Int).Value = itemReference;
        command.Parameters.Add("@list", System.Data.SqlDbType.Int).Value = priceListNo;
        command.Parameters.Add("@unit", System.Data.SqlDbType.NVarChar, 64).Value =
            (object?)unitCode ?? DBNull.Value;

        var sonuc = await command.ExecuteScalarAsync(ct);

        return sonuc is null or DBNull ? null : Convert.ToInt32(sonuc);
    }
}
