using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

using ToptanPortal.LogoBridge.Configuration;

namespace ToptanPortal.LogoBridge.Security;

/// <summary>
/// Istemci sertifikasini parmak izi listesine gore dogrular.
///
/// Zincir dogrulamasi (CA, sure, iptal) Kestrel tarafindan yapilir; burada
/// sorulan soru farklidir: "zinciri gecerli olan bu sertifika, BENIM izin
/// verdigim sertifika mi?" Ayni CA baska sertifikalar da imzalayabilir ve
/// sirket ici agda duran bir servis icin bu fark, tunelin tek musterisi
/// olmakla herkese acik olmak arasindaki farktir.
///
/// Karsilastirma SABIT ZAMANLIDIR. Parmak izi gizli bir deger degildir, ama
/// erken donen bir karsilastirma listenin icerigi hakkinda bilgi sizdirir ve
/// bu maliyeti odememek icin bir sebep yoktur.
/// </summary>
public sealed class ClientCertificateValidator
{
    private readonly byte[][] _allowed;
    private readonly ILogger<ClientCertificateValidator> _logger;

    public ClientCertificateValidator(BridgeOptions options, ILogger<ClientCertificateValidator> logger)
    {
        _logger = logger;
        _allowed = options.AllowedClientThumbprints
            .Select(Normalize)
            .Where(value => value.Length > 0)
            .Select(Convert.FromHexString)
            .ToArray();
    }

    private static string Normalize(string thumbprint) =>
        thumbprint.Replace(":", string.Empty).Replace(" ", string.Empty).Trim().ToUpperInvariant();

    public bool IsAllowed(X509Certificate2 certificate)
    {
        var actual = SHA256.HashData(certificate.RawData);

        foreach (var expected in _allowed)
        {
            if (CryptographicOperations.FixedTimeEquals(actual, expected))
            {
                return true;
            }
        }

        _logger.LogWarning(
            "İzin verilmeyen istemci sertifikası reddedildi. Konu: {Subject}, parmak izi: {Thumbprint}",
            certificate.Subject,
            Convert.ToHexString(actual));

        return false;
    }
}
