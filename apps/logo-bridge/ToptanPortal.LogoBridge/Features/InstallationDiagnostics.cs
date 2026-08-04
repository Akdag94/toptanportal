using Microsoft.Data.SqlClient;

using ToptanPortal.LogoBridge.Configuration;
using ToptanPortal.LogoBridge.Data;

namespace ToptanPortal.LogoBridge.Features;

/// <summary>
/// Kurulum tanilamasi.
///
/// KOPRUNUN SAHADAKI EN SIK SORUNU, TABLO VE ALAN ADLARIDIR. Tiger 3, Go Wings
/// ve Enterprise arasinda ad farklari vardir; firma ve donem numarasi tablo
/// adina gomulur ve yil sonu devrinde donem degisir. Bunlarin herhangi biri
/// yanlissa kopru ACILIR, saglikli gorunur ve ilk senkron turunda anlamsiz bir
/// SQL hatasiyla durur - hatayi goren kisi ise bulut tarafindaki gunluklerdir.
///
/// Bu uc, o hatayi KURULUM ANINDA ve INSAN OKUYABILIR bicimde verir: hangi
/// tablo yok, hangi kolon eksik, hangi donem acik. Kurulumu yapan kisinin
/// Logo'ya baglanip elle sorgu yazmasi gerekmez.
///
/// Tanilama SALT OKUNURDUR ve hicbir seyi degistirmez; hata durumunda da
/// istisna atmaz - amaci sorunu RAPORLAMAKTIR, kendisi patlamak degil.
/// </summary>
public sealed class InstallationDiagnostics
{
    private readonly LogoDatabase _db;
    private readonly BridgeOptions _options;
    private readonly ILogoOrderSink _sink;
    private readonly ILogoCatalogSink _catalogSink;

    public InstallationDiagnostics(
        LogoDatabase db,
        BridgeOptions options,
        ILogoOrderSink sink,
        ILogoCatalogSink catalogSink)
    {
        _db = db;
        _options = options;
        _sink = sink;
        _catalogSink = catalogSink;
    }

    /// <summary>Koprunun okudugu her tablo ve o tablodan istedigi kolonlar.</summary>
    private IReadOnlyList<(string Table, string[] Columns)> RequiredObjects =>
    [
        (_options.PeriodTable("STINVTOT"), ["LOGICALREF", "STOCKREF", "INVENNO", "ONHAND", "ORDERRESERVED"]),
        /* CARDTYPE ve PRELISTNO katalog YAZIMI icin gereklidir: ilki portalin
           ustune yazamayacagi kart turlerini ayirt eder, ikincisi fiyatin hangi
           listeye yazildigini belirler. Okuma akislari onlarsiz da calisirdi;
           yazim calismaz ve eksiklik ilk kart aciminda gorunur. */
        (_options.FirmTable("ITEMS"), ["LOGICALREF", "CODE", "ACTIVE", "UNITSETREF", "CARDTYPE"]),
        (_options.FirmTable("UNITSETL"), ["LOGICALREF", "CODE", "MAINUNIT"]),
        (_options.FirmTable("PRCLIST"), ["LOGICALREF", "CARDREF", "PTYPE", "PRICE", "PRELISTNO", "UOMREF"]),
        (_options.FirmTable("CLCARD"), ["LOGICALREF", "CODE"]),
        (_options.FirmTable("INVDEF"), ["NR"]),
        (_options.PeriodTable("CLFLINE"), ["LOGICALREF", "CLIENTREF", "TRCODE", "DEBIT", "CREDIT"]),
        ("PORTAL_ORDER_MAP", ["PortalOrderId", "PortalOrderNumber", "LogoOrderNumber", "LogoReference", "TransferredAt"]),
    ];

    public async Task<BridgeDiagnostics> RunAsync(CancellationToken ct)
    {
        var bulgular = new List<DiagnosticFinding>();

        SqlConnection? connection = null;

        try
        {
            connection = await _db.OpenAsync(ct);
        }
        catch (SqlException ex)
        {
            /* Veritabanina hic baglanilamiyorsa geri kalan denetimlerin hicbiri
               anlamli degildir; tek bir net cumleyle donulur. */
            bulgular.Add(new DiagnosticFinding(
                "database",
                "FAIL",
                $"Logo veritabanına bağlanılamadı: {ex.Message}"));

            return Sonuc(bulgular);
        }

        await using (connection)
        {
            foreach (var (tablo, kolonlar) in RequiredObjects)
            {
                bulgular.Add(await CheckTableAsync(connection, tablo, kolonlar, ct));
            }

            bulgular.Add(await CheckPeriodAsync(connection, ct));
        }

        bulgular.Add(await CheckOrderSinkAsync(ct));
        bulgular.Add(await CheckCatalogSinkAsync(ct));

        return Sonuc(bulgular);
    }

    private static BridgeDiagnostics Sonuc(List<DiagnosticFinding> bulgular)
    {
        /* Tek bir "sagliksiz" bayragi yerine sayimlar donulur: kurulumu yapan
           kisi neyin eksik oldugunu degil, KAC seyin eksik oldugunu da gorur
           ve isin buyuklugunu tahmin edebilir. */
        var hata = bulgular.Count(b => b.Status == "FAIL");
        var uyari = bulgular.Count(b => b.Status == "WARN");

        return new BridgeDiagnostics(
            Status: hata > 0 ? "FAIL" : uyari > 0 ? "WARN" : "PASS",
            FailureCount: hata,
            WarningCount: uyari,
            Findings: bulgular,
            CheckedAt: DateTime.UtcNow.ToString("O"));
    }

    /// <summary>
    /// Tablo var mi, istenen kolonlari tasiyor mu?
    ///
    /// Tablonun varligi YETMEZ: Logo surumleri arasinda ayni tablo farkli
    /// kolonlar tasiyabilir ve eksik bir kolon, ilk senkronda "Invalid column
    /// name" hatasi verir. Kolon adlari `sys.columns` uzerinden PARAMETRE ile
    /// sorulur; tablo adi ise yapilandirmadan gelen SAYILARDAN uretildigi icin
    /// serbest metin degildir.
    /// </summary>
    private async Task<DiagnosticFinding> CheckTableAsync(
        SqlConnection connection,
        string table,
        string[] columns,
        CancellationToken ct)
    {
        const string sql = """
            SELECT c.name
            FROM   sys.columns c
            JOIN   sys.objects o ON o.object_id = c.object_id
            WHERE  o.name = @table AND o.type IN ('U', 'V')
            """;

        await using var command = new SqlCommand(sql, connection);
        command.CommandTimeout = _options.CommandTimeoutSeconds;
        command.Parameters.Add("@table", System.Data.SqlDbType.NVarChar, 128).Value = table;

        var mevcut = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        await using (var reader = await command.ExecuteReaderAsync(ct))
        {
            while (await reader.ReadAsync(ct))
            {
                mevcut.Add(reader.GetString(0));
            }
        }

        if (mevcut.Count == 0)
        {
            return new DiagnosticFinding(
                table,
                "FAIL",
                $"{table} tablosu/görünümü bulunamadı. Firma ({_options.FirmNumber}) ve dönem " +
                $"({_options.PeriodNumber}) numaralarını ve Logo sürümünü doğrulayın.");
        }

        var eksik = columns.Where(kolon => !mevcut.Contains(kolon)).ToArray();

        return eksik.Length == 0
            ? new DiagnosticFinding(table, "PASS", $"{table} erişilebilir ({mevcut.Count} kolon).")
            : new DiagnosticFinding(
                table,
                "FAIL",
                $"{table} tablosunda beklenen kolonlar yok: {string.Join(", ", eksik)}. " +
                "Logo sürümüne göre alan adları değişmiş olabilir.");
    }

    /// <summary>
    /// Yapilandirilan donem Logo'da ACIK mi?
    ///
    /// Yil sonu devrinden sonra guncellenmeyen bir donem numarasi, koprunun
    /// kapanan donemi okumaya devam etmesi demektir: yeni siparisler gorunmez,
    /// stok eski donemden okunur ve hicbir hata mesaji cikmaz. Sessiz yanlis,
    /// gurultulu hatadan tehlikelidir.
    /// </summary>
    private async Task<DiagnosticFinding> CheckPeriodAsync(SqlConnection connection, CancellationToken ct)
    {
        const string sql = """
            SELECT TOP 1 NR, BEGDATE, ENDDATE
            FROM   L_CAPIFIRM F
            JOIN   L_CAPIPERIOD P ON P.FIRMNR = F.NR
            WHERE  F.NR = @firm AND P.NR = @period
            """;

        try
        {
            await using var command = new SqlCommand(sql, connection);
            command.CommandTimeout = _options.CommandTimeoutSeconds;
            command.Parameters.Add("@firm", System.Data.SqlDbType.Int).Value = _options.FirmNumber;
            command.Parameters.Add("@period", System.Data.SqlDbType.Int).Value = _options.PeriodNumber;

            await using var reader = await command.ExecuteReaderAsync(ct);

            if (!await reader.ReadAsync(ct))
            {
                return new DiagnosticFinding(
                    "period",
                    "FAIL",
                    $"Firma {_options.FirmNumber} için {_options.PeriodNumber} numaralı dönem " +
                    "Logo'da tanımlı değil. Yıl sonu devri sonrası dönem numarası güncellenmemiş olabilir.");
            }

            var bitis = reader.IsDBNull(2) ? (DateTime?)null : reader.GetDateTime(2);

            return bitis is not null && bitis < DateTime.Today
                ? new DiagnosticFinding(
                    "period",
                    "WARN",
                    $"{_options.PeriodNumber} numaralı dönem {bitis:dd.MM.yyyy} tarihinde bitmiş. " +
                    "Köprü kapanmış dönemi okuyor; yeni siparişler görünmeyecektir.")
                : new DiagnosticFinding("period", "PASS", $"Dönem {_options.PeriodNumber} açık.");
        }
        catch (SqlException ex)
        {
            /* Donem tablolarinin adi da surume gore degisebilir. Bunu FAIL
               saymak, calisan bir kurulumu hatali gostermek olurdu; uyari
               yeterlidir. */
            return new DiagnosticFinding(
                "period",
                "WARN",
                $"Dönem bilgisi okunamadı ({ex.Message}). Dönem numarası elle doğrulanmalıdır.");
        }
    }

    private async Task<DiagnosticFinding> CheckOrderSinkAsync(CancellationToken ct)
    {
        if (!_options.CanWriteOrders)
        {
            /* Yapilandirilmamis siparis yazimi bir HATA degildir: yalnizca
               okuma yapan bir kurulum mesrudur. Ama sessiz de gecilmez -
               "siparisler Logo'ya dusmuyor" sikayetinin cevabi bu satirdir. */
            return new DiagnosticFinding(
                "object-service",
                "WARN",
                "Bridge:ObjectServiceUrl tanımlı değil; sipariş yazımı KAPALIDIR. " +
                "Portalden gelen siparişler kalıcı hata alır.");
        }

        var ulasildi = await _sink.ProbeAsync(ct);

        return ulasildi
            ? new DiagnosticFinding("object-service", "PASS", "Logo Object Service erişilebilir.")
            : new DiagnosticFinding(
                "object-service",
                "FAIL",
                $"Logo Object Service adresine ({_options.ObjectServiceUrl}) ulaşılamadı.");
    }

    /// <summary>
    /// Katalog yazimi acik mi ve ucuna ulasilabiliyor mu?
    ///
    /// Kapali olmasi HATA degildir - yalnizca okuyan, katalogunu Logo'da yoneten
    /// bir kurulum mesrudur. Ama sessiz de gecilmez: "portalden urun ekledim,
    /// Logo'da gorunmuyor" sikayetinin cevabi bu satirdir.
    /// </summary>
    private async Task<DiagnosticFinding> CheckCatalogSinkAsync(CancellationToken ct)
    {
        if (!_options.CanWriteCatalog)
        {
            return new DiagnosticFinding(
                "catalog-service",
                "WARN",
                "Bridge:ObjectServiceItemUrl / ObjectServicePriceUrl tanımlı değil; " +
                "katalog yazımı KAPALIDIR. Portalden açılan ürün ve değiştirilen fiyat " +
                "Logo'ya geçmez, kalıcı hata alır.");
        }

        var ulasildi = await _catalogSink.ProbeAsync(ct);

        return ulasildi
            ? new DiagnosticFinding("catalog-service", "PASS", "Katalog yazım ucu erişilebilir.")
            : new DiagnosticFinding(
                "catalog-service",
                "FAIL",
                $"Katalog yazım adresine ({_options.ObjectServiceItemUrl}) ulaşılamadı.");
    }
}
