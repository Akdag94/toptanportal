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
    client.Timeout = TimeSpan.FromSeconds(30);
});
/* OrderWriter SCOPED'dir: tipli HttpClient'i tasir ve singleton bir sinifin
   icinde tutulan HttpClient, DNS degisikliklerini gormez. */
builder.Services.AddScoped<OrderWriter>();

// ---------------------------------------------------------------------------
// mTLS
//
// Istemci sertifikasi ZORUNLUDUR. Kestrel zinciri dogrular; parmak izi
// denetimi ayrica yapilir (bkz. ClientCertificateValidator).
// ---------------------------------------------------------------------------

builder.WebHost.ConfigureKestrel(kestrel =>
{
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

app.MapBridgeEndpoints();

app.Run();

/// <summary>Tumlesik testlerin uygulamayi ayaga kaldirabilmesi icin.</summary>
public partial class Program;
