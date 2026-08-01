using Microsoft.Data.SqlClient;

using ToptanPortal.LogoBridge.Configuration;
using ToptanPortal.LogoBridge.Data;

namespace ToptanPortal.LogoBridge.Features;

/// <summary>
/// Siparis yazimi.
///
/// LOGO FIS TABLOLARINA DOGRUDAN INSERT YAPILMAZ. ORFICHE/ORFLINE'a elle satir
/// yazmak, Logo'nun kendi tutarlilik mantigini (numaralama, stok hareketi,
/// muhasebe baglantisi, doviz cevrimi) atlar; kayit gorunur ama Logo icinde
/// yarim kalir ve donem sonunda tutmaz. Yazma islemi bu yuzden Logo'nun kendi
/// servis katmanina devredilir (<see cref="ILogoOrderSink"/>).
///
/// IDEMPOTENCY bu sinifin ikinci isidir. Portal ag zaman asiminda ayni siparisi
/// tekrar gonderir; eslesme tablosu sayesinde ikinci cagri YENI FIS ACMAZ,
/// ilkinin sonucunu doner. Mukerrer siparis, kaybolan siparisten pahalidir:
/// sevk edilir ve fatura edilir.
/// </summary>
public sealed class OrderWriter
{
    private readonly LogoDatabase _db;
    private readonly BridgeOptions _options;
    private readonly ILogoOrderSink _sink;
    private readonly ILogger<OrderWriter> _logger;

    public OrderWriter(
        LogoDatabase db,
        BridgeOptions options,
        ILogoOrderSink sink,
        ILogger<OrderWriter> logger)
    {
        _db = db;
        _options = options;
        _sink = sink;
        _logger = logger;
    }

    public async Task<(BridgeOrderResult? Result, BridgeError? Error)> WriteAsync(
        BridgeOrderPush order,
        CancellationToken ct)
    {
        await using var connection = await _db.OpenAsync(ct);

        var mevcut = await FindExistingAsync(connection, order.PortalOrderId, _options.CommandTimeoutSeconds, ct);

        if (mevcut is not null)
        {
            _logger.LogInformation(
                "{OrderNumber} zaten aktarılmış; mevcut sonuç döndürüldü.", order.OrderNumber);
            return (mevcut, null);
        }

        var dogrulama = await ValidateAsync(connection, order, ct);

        if (dogrulama is not null)
        {
            return (null, dogrulama);
        }

        var sonuc = await _sink.SendAsync(order, ct);

        if (sonuc.Error is not null)
        {
            return (null, sonuc.Error);
        }

        await RecordAsync(connection, order, sonuc.LogoOrderNumber!, sonuc.LogoReference, ct);

        return (new BridgeOrderResult(
            order.PortalOrderId,
            sonuc.LogoOrderNumber!,
            sonuc.LogoReference,
            Created: true,
            TransferredAt: DateTime.UtcNow.ToString("O")), null);
    }

    private static async Task<BridgeOrderResult?> FindExistingAsync(
        SqlConnection connection,
        Guid portalOrderId,
        int commandTimeout,
        CancellationToken ct)
    {
        const string sql = """
            SELECT LogoOrderNumber, LogoReference, TransferredAt
            FROM   PORTAL_ORDER_MAP
            WHERE  PortalOrderId = @id
            """;

        await using var command = new SqlCommand(sql, connection);
        command.CommandTimeout = commandTimeout;
        command.Parameters.Add("@id", System.Data.SqlDbType.UniqueIdentifier).Value = portalOrderId;

        await using var reader = await command.ExecuteReaderAsync(ct);

        if (!await reader.ReadAsync(ct))
        {
            return null;
        }

        return new BridgeOrderResult(
            portalOrderId,
            reader.GetString(0),
            reader.GetInt32(1),
            Created: false,
            TransferredAt: reader.GetDateTime(2).ToString("O"));
    }

    /// <summary>
    /// Logo'da karsiligi olmayan kart, kalici hatadir: tekrar denemek ayni
    /// sonucu verir. Hangi kodun sorunlu oldugu ISIMLE donulur - operator
    /// eksigi Logo'da acacaktir, "doğrulama başarısız" mesaji onu bos yere
    /// aratir.
    /// </summary>
    private async Task<BridgeError?> ValidateAsync(
        SqlConnection connection,
        BridgeOrderPush order,
        CancellationToken ct)
    {
        if (order.Lines.Count == 0)
        {
            return BridgeError.Validation("Sipariş satırsız gönderilemez.");
        }

        var cariVar = await ExistsAsync(
            connection,
            $"SELECT TOP 1 1 FROM {_options.FirmTable("CLCARD")} WHERE CODE = @code",
            order.CompanyLogoCode,
            ct);

        if (!cariVar)
        {
            return BridgeError.UnknownCompany(order.CompanyLogoCode);
        }

        if (!int.TryParse(order.WarehouseCode, out var ambarNo))
        {
            return BridgeError.UnknownWarehouse(order.WarehouseCode);
        }

        var ambarVar = await ExistsAsync(
            connection,
            $"SELECT TOP 1 1 FROM {_options.FirmTable("INVDEF")} WHERE NR = @code",
            ambarNo.ToString(),
            ct);

        if (!ambarVar)
        {
            return BridgeError.UnknownWarehouse(order.WarehouseCode);
        }

        foreach (var line in order.Lines)
        {
            var urunVar = await ExistsAsync(
                connection,
                $"SELECT TOP 1 1 FROM {_options.FirmTable("ITEMS")} WHERE CODE = @code AND ACTIVE = 0",
                line.LogoCode,
                ct);

            if (!urunVar)
            {
                return BridgeError.UnknownProduct(line.LogoCode);
            }
        }

        return null;
    }

    private async Task<bool> ExistsAsync(
        SqlConnection connection,
        string sql,
        string code,
        CancellationToken ct)
    {
        await using var command = new SqlCommand(sql, connection);
        command.CommandTimeout = _options.CommandTimeoutSeconds;
        command.Parameters.Add("@code", System.Data.SqlDbType.NVarChar, 64).Value = code;
        return await command.ExecuteScalarAsync(ct) is not null;
    }

    /// <summary>
    /// Eslesmeyi yazar. Benzersizlik kisiti ihlali BASARI sayilir: iki es
    /// zamanli cagri ayni siparisi yazmaya calistiysa, ikincinin gorevi zaten
    /// yapilmistir.
    /// </summary>
    private async Task RecordAsync(
        SqlConnection connection,
        BridgeOrderPush order,
        string logoOrderNumber,
        int logoReference,
        CancellationToken ct)
    {
        const string sql = """
            INSERT INTO PORTAL_ORDER_MAP
                (PortalOrderId, PortalOrderNumber, LogoOrderNumber, LogoReference, TransferredAt)
            VALUES (@id, @portalNumber, @logoNumber, @logoRef, SYSUTCDATETIME())
            """;

        try
        {
            await using var command = new SqlCommand(sql, connection);
            command.CommandTimeout = _options.CommandTimeoutSeconds;
            command.Parameters.Add("@id", System.Data.SqlDbType.UniqueIdentifier).Value = order.PortalOrderId;
            command.Parameters.Add("@portalNumber", System.Data.SqlDbType.NVarChar, 24).Value = order.OrderNumber;
            command.Parameters.Add("@logoNumber", System.Data.SqlDbType.NVarChar, 32).Value = logoOrderNumber;
            command.Parameters.Add("@logoRef", System.Data.SqlDbType.Int).Value = logoReference;

            await command.ExecuteNonQueryAsync(ct);
        }
        catch (SqlException ex) when (ex.Number is 2601 or 2627)
        {
            _logger.LogInformation(
                "{OrderNumber} eşleşmesi başka bir istek tarafından yazılmış.", order.OrderNumber);
        }
    }
}
