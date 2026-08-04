namespace ToptanPortal.LogoBridge.Features;

/// <summary>
/// Kopru protokolunun .NET tarafi. Alan adlari ve turleri
/// <c>packages/contracts/src/integration.schema.ts</c> ile BIRE BIR ayni
/// olmalidir; bulut tarafi yaniti Zod ile dogrular ve uymayan bir alan KALICI
/// hata sayilir - yani sessizce degil, gorunur sekilde kirilir. Bu bilincli
/// bir tercihtir: iki ucun sozlesmesi ayrisirsa erken ogrenmek gerekir.
/// </summary>
public sealed record BridgeHealth(
    string Status,
    string Version,
    bool LogoServiceUp,
    bool DatabaseUp,
    int CompanyNumber,
    int PeriodNumber,
    string CheckedAt,
    string? Message);

/// <summary>
/// Kurulum tanilamasinin tek bulgusu.
///
/// `Status` uc degerlidir ve ucu de gereklidir: FAIL kurulumu durdurur, WARN
/// calisan ama eksik bir kurulumu isaret eder (ornek: siparis yazimi kapali),
/// PASS ise "bu denetim yapildi ve gecti" der. Yalnizca hatalari dondurmek,
/// denetimin CALISTIGINI dogrulanamaz kilardi.
/// </summary>
public sealed record DiagnosticFinding(string Target, string Status, string Message);

public sealed record BridgeDiagnostics(
    string Status,
    int FailureCount,
    int WarningCount,
    IReadOnlyList<DiagnosticFinding> Findings,
    string CheckedAt);

public sealed record StockDeltaItem(
    string LogoCode,
    string WarehouseCode,
    decimal OnHand,
    decimal Allocated,
    string UnitCode,
    string ChangedAt);

public sealed record StockDeltaPage(IReadOnlyList<StockDeltaItem> Items, string NextCursor, bool HasMore);

public sealed record PriceDeltaItem(
    string LogoCode,
    string PriceListCode,
    string UnitCode,
    decimal Price,
    string Currency,
    string? ValidFrom,
    string? ValidTo,
    string ChangedAt);

public sealed record PriceDeltaPage(IReadOnlyList<PriceDeltaItem> Items, string NextCursor, bool HasMore);

public sealed record AccountDeltaItem(
    string LogoCode,
    int FicheRef,
    string DocumentNumber,
    int DocumentType,
    string EntryDate,
    string? DueDate,
    decimal Debit,
    decimal Credit,
    string? Description,
    string ChangedAt);

public sealed record AccountDeltaPage(IReadOnlyList<AccountDeltaItem> Items, string NextCursor, bool HasMore);

public sealed record BridgeOrderLine(
    string LogoCode,
    string UnitCode,
    decimal Quantity,
    decimal UnitPrice,
    decimal DiscountRate,
    decimal VatRate,
    string? LineNote);

public sealed record BridgeOrderPush(
    Guid PortalOrderId,
    string OrderNumber,
    string CompanyLogoCode,
    string WarehouseCode,
    string OrderDate,
    string? DeliveryDate,
    string Currency,
    string? CustomerNote,
    IReadOnlyList<BridgeOrderLine> Lines);

public sealed record BridgeOrderResult(
    Guid PortalOrderId,
    string LogoOrderNumber,
    int LogoReference,
    bool Created,
    string TransferredAt);

// ---------------------------------------------------------------------------
// Katalog yazimi (portal -> Logo)
//
// Okuma akislarinin tersi yon. Buradaki her cagri Logo'da KALICI bir kart ya da
// fiyat satiri birakir; ikisi de idempotenttir cunku ag zaman asiminda
// "yazdim mi?" sorusu cevapsizdir ve portal tekrar dener.
// ---------------------------------------------------------------------------

public sealed record BridgeItemUnit(
    string Code,
    string Name,
    decimal ConversionFactor,
    bool IsBaseUnit);

/// <summary>
/// Stok karti yazimi. Anahtar <c>LogoItemCode</c>: kart yoksa acilir, varsa
/// guncellenir.
///
/// Alan listesi bilincli olarak DARDIR. Logo stok kartinda yuzlerce alan
/// bulunur; portalin bilmedigi bir alani "varsayilanla" yazmak, muhasebecinin
/// elle girdigi degeri sessizce ezer. Portal yalnizca kendi dogurdugu bilgiyi
/// yazar, geri kalanina Logo'nun varsayilanlari karar verir.
/// </summary>
public sealed record BridgeItemPush(
    string LogoItemCode,
    string Name,
    string? Brand,
    decimal VatRate,
    IReadOnlyList<BridgeItemUnit> Units,
    bool IsActive);

public sealed record BridgeItemResult(
    string LogoItemCode,
    int LogoItemRef,
    bool Created,
    string WrittenAt);

public sealed record BridgePricePush(
    string LogoItemCode,
    string PriceListCode,
    string? UnitCode,
    decimal MinQuantity,
    decimal Price,
    string Currency,
    string? ValidFrom,
    string? ValidTo);

public sealed record BridgePriceResult(
    string LogoItemCode,
    string PriceListCode,
    int LogoPriceRef,
    bool Created,
    string WrittenAt);

/// <summary>
/// Reddetme sebebi. Bulut tarafi bu degere gore olayi OLU isaretler; geri
/// donusu olmayan bir karardir, bu yuzden yalnizca gercekten tekrar
/// denenmesi anlamsiz durumlarda uretilir.
/// </summary>
public sealed record BridgeError(string Reason, string Message, string? OffendingCode)
{
    public static BridgeError UnknownProduct(string code) =>
        new("UNKNOWN_PRODUCT", $"Logo'da {code} kodlu stok kartı bulunamadı.", code);

    public static BridgeError UnknownCompany(string code) =>
        new("UNKNOWN_COMPANY", $"Logo'da {code} kodlu cari hesap bulunamadı.", code);

    public static BridgeError UnknownWarehouse(string code) =>
        new("UNKNOWN_WAREHOUSE", $"Logo'da {code} numaralı ambar bulunamadı.", code);

    public static BridgeError UnknownPriceList(string code) =>
        new("UNKNOWN_PRICE_LIST", $"Logo'da {code} numaralı fiyat listesi bulunamadı.", code);

    public static BridgeError UnknownUnit(string code) =>
        new("UNKNOWN_UNIT", $"Logo'da {code} kodlu birim bulunamadı.", code);

    /// <summary>
    /// Kod Logo'da var ama portalin yazabilecegi TURDE bir kart degil.
    ///
    /// Ustune yazmak, muhasebenin baska amacla actigi bir karti portal urunune
    /// cevirirdi - ve o kartin gecmis hareketleri oldugu yerde kalirdi. Kalici
    /// hatadir; cozum operatorun karari (portaldeki karti arsivleyip baska kodla
    /// acmak).
    /// </summary>
    public static BridgeError DuplicateItemCode(string code) =>
        new("DUPLICATE_ITEM_CODE",
            $"Logo'da {code} kodu portalin yazamayacağı türde bir kartta kullanılıyor.",
            code);

    public static BridgeError PeriodClosed(int period) =>
        new("PERIOD_CLOSED", $"Logo {period} numaralı dönem kapalı; sipariş yazılamaz.", null);

    public static BridgeError Validation(string message) =>
        new("VALIDATION_FAILED", message, null);
}
