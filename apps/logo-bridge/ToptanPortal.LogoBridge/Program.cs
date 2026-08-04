using System.Security.Cryptography.X509Certificates;

using Microsoft.AspNetCore.Server.Kestrel.Https;

using ToptanPortal.LogoBridge.Configuration;
using ToptanPortal.LogoBridge.Data;
using ToptanPortal.LogoBridge.Features;
using ToptanPortal.LogoBridge.Security;

var builder = WebApplication.CreateBuilder(args);

// ---------------------------------------------------------------------------
// Yapilandirma - acilista dogrulanir
// ---------------------------------------------------------------------------

var options = builder.Configuration.GetSection(BridgeOptions.SectionName).Get<BridgeOptions>()
              ?? new BridgeOptions();

var hatalar = options.Validate().ToArray();

if (hatalar.Length > 0)
{
    throw new InvalidOperationException(
        "Köprü yapılandırması geçersiz:" + Environment.NewLine +
        string.Join(Environment.NewLine, hatalar.Select(h => "  - " + h)));
}

builder.Services.AddSingleton(options);
builder.Services.AddSingleton<LogoDatabase>();
builder.Services.AddSingleton<ClientCertificateValidator>();
builder.Services.AddSingleton<StockReader>();
builder.Services.AddSingleton<PriceReader>();
builder.Services.AddSingleton<AccountReader>();
builder.Services.AddHttpClient<ILogoOrderSink, ObjectServiceOrderSink>(client =>
{
    /* Siparis yazimi Logo tarafinda yavastir; okuma cagrilarindan belirgin
       sekilde uzun bir pay birakilir. */
    client.Timeout = TimeSpan.FromSeconds(options.ObjectServiceTimeoutSeconds);
});
builder.Services.AddHttpClient<ILogoCatalogSink, ObjectServiceCatalogSink>(client =>
{
    client.Timeout = TimeSpan.FromSeconds(options.ObjectServiceTimeoutSeconds);
});
/* OrderWriter ve tanilama SCOPED'dir: tipli HttpClient'i tasirlar ve singleton
   bir sinifin icinde tutulan HttpClient, DNS degisikliklerini gormez. */
builder.Services.AddScoped<OrderWriter>();
builder.Services.AddScoped<CatalogWriter>();
builder.Services.AddScoped<InstallationDiagnostics>();

/* ES ZAMANLILIK SINIRI.

   Kopru, Logo veritabanini portalin yukune karsi KORUYAN taraftir. Bulut
   tarafindaki bir dongu hatasi, sinir olmadiginda muhasebe sistemini
   yavaslatir; yavaslayan muhasebe sistemi portalden cok daha pahali bir
   aksamadir. Sinir asildiginda istek REDDEDILIR (503), kuyruga alinmaz:
   kuyrukta bekleyen istek zaten zaman asimina ugrayacak ve portal tekrar
   deneyecektir - beklemek yalnizca gecikmeyi buyutur. */
builder.Services.AddSingleton(new SemaphoreSlim(options.MaxConcurrentRequests));

// ---------------------------------------------------------------------------
// mTLS
//
// Istemci sertifikasi ZORUNLUDUR. Kestrel zinciri dogrular; parmak izi
// denetimi ayrica yapilir (bkz. ClientCertificateValidator).
// ---------------------------------------------------------------------------

builder.WebHost.ConfigureKestrel(kestrel =>
{
    /* ISTEK GOVDESI SINIRI. Kopru yalnizca siparis alir; en buyuk mesru govde
       birkac yuz kalemlik bir siparistir. Sinirsiz govde, sirket ici agdaki
       gozetimsiz bir servisi tek istekle bellek tuketimine acar. */
    kestrel.Limits.MaxRequestBodySize = 4 * 1024 * 1024;

    kestrel.ConfigureHttpsDefaults(https =>
    {
        https.ClientCertificateMode = ClientCertificateMode.RequireCertificate;
        https.CheckCertificateRevocation = true;

        /* Zincir dogrulamasi burada; kimlik denetimi ara katmanda. Ikisini tek
           yere koymak, sertifika gecerliyken parmak izi yanlissa dogru hata
           mesajini uretmeyi zorlastirir. */
        https.ClientCertificateValidation = (certificate, chain, errors) =>
            errors == System.Net.Security.SslPolicyErrors.None && chain is not null && certificate is not null;
    });
});

var app = builder.Build();

// ---------------------------------------------------------------------------
// Istek gunlugu
//
// Kopru GOZETIMSIZ calisir ve sirket ici agdadir: bir sorun yasandiginda
// elimizdeki tek sey bu gunluktur. Govde YAZILMAZ - siparis govdesi cari kodu,
// urun ve tutar tasir; disk uzerinde birikmesi icin bir sebep yoktur.
//
// Gunluk EN DISTA durur: reddedilen sertifika ve yogunluk nedeniyle geri
// cevrilen istek de kaydedilmelidir - "koprüye baglanamiyorum" sikayetinin
// cevabi tam olarak o satirlardir.
// ---------------------------------------------------------------------------

app.Use(async (context, next) =>
{
    var baslangic = System.Diagnostics.Stopwatch.GetTimestamp();
    var gunluk = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Bridge.Request");

    try
    {
        await next();
    }
    finally
    {
        var sure = System.Diagnostics.Stopwatch.GetElapsedTime(baslangic);

        gunluk.Log(
            /* Basarili istek BILGI degil, izleme (Debug) seviyesindedir: iki
               dakikada bir gelen stok istegi, gunlugu okunamaz hale getirir.
               Hatali istek her zaman gorunur. */
            context.Response.StatusCode >= 500 ? LogLevel.Error
                : context.Response.StatusCode >= 400 ? LogLevel.Warning
                : LogLevel.Debug,
            "{Method} {Path} -> {Status} ({Duration} ms)",
            context.Request.Method,
            context.Request.Path.Value,
            context.Response.StatusCode,
            (int)sure.TotalMilliseconds);
    }
});

// ---------------------------------------------------------------------------
// Kimlik ara katmani
// ---------------------------------------------------------------------------

app.Use(async (context, next) =>
{
    var certificate = await context.Connection.GetClientCertificateAsync(context.RequestAborted);
    var validator = context.RequestServices.GetRequiredService<ClientCertificateValidator>();

    if (certificate is null || !validator.IsAllowed(certificate))
    {
        /* 403 doner, 401 DEGIL: 401 bir kimlik dogrulama yontemi onerir ve
           istemcinin tekrar denemesini bekler. Burada tekrar denenecek bir sey
           yoktur - sertifika ya listededir ya degildir. */
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        await context.Response.WriteAsJsonAsync(new
        {
            reason = "VALIDATION_FAILED",
            message = "İstemci sertifikası kabul edilmedi.",
            offendingCode = (string?)null,
        });
        return;
    }

    await next();
});

// ---------------------------------------------------------------------------
// Es zamanlilik sinirlayicisi
// ---------------------------------------------------------------------------

app.Use(async (context, next) =>
{
    var kapi = context.RequestServices.GetRequiredService<SemaphoreSlim>();

    if (!await kapi.WaitAsync(TimeSpan.Zero, context.RequestAborted))
    {
        /* 503 + Retry-After: portal tarafi bunu GECICI hata olarak siniflar ve
           olayi kuyrukta tutar (bkz. integration hata siniflandirmasi). 4xx
           donmek, kalici hata sayilmasina ve siparisin olu isaretlenmesine yol
           acardi - oysa tek sorun, o anki yogunluktur. */
        context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
        context.Response.Headers.RetryAfter = "5";
        await context.Response.WriteAsJsonAsync(new
        {
            reason = "BUSY",
            message = "Köprü eşzamanlı istek sınırına ulaştı; istek reddedildi.",
            offendingCode = (string?)null,
        });
        return;
    }

    try
    {
        await next();
    }
    finally
    {
        kapi.Release();
    }
});

app.MapBridgeEndpoints();

app.Logger.LogInformation(
    "Köprü açıldı. Firma: {Firm}, dönem: {Period}, izinli sertifika: {Certificates}, " +
        "sipariş yazımı: {OrderWrite}, katalog yazımı: {CatalogWrite}. " +
        "Kurulum doğrulaması için: GET /bridge/v1/diagnostics",
    options.FirmNumber,
    options.PeriodNumber,
    options.AllowedClientThumbprints.Length,
    options.CanWriteOrders ? "açık" : "KAPALI",
    options.CanWriteCatalog ? "açık" : "KAPALI");

app.Run();

/// <summary>Tumlesik testlerin uygulamayi ayaga kaldirabilmesi icin.</summary>
public partial class Program;
