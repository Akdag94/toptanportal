using Microsoft.Data.SqlClient;

using ToptanPortal.LogoBridge.Configuration;

namespace ToptanPortal.LogoBridge.Data;

/// <summary>
/// Logo veritabanina salt-okunur erisim.
///
/// TABLO ADLARI parametre OLAMAZ - firma ve donem numarasi tablo adina gomulur
/// (LG_001_01_ORFICHE). Bu yuzden ad, yapilandirmadan gelen SAYILARDAN
/// uretilir ve sayilar acilista aralik denetiminden gecer. Serbest metinden
/// tablo adi kurmak, SQL enjeksiyonuna dogrudan davetiyedir.
///
/// Veri degerleri her zaman parametreyle gecer; istisnasi yoktur.
/// </summary>
public sealed class LogoDatabase
{
    private readonly BridgeOptions _options;

    public LogoDatabase(BridgeOptions options) => _options = options;

    public async Task<SqlConnection> OpenAsync(CancellationToken cancellationToken)
    {
        var connection = new SqlConnection(_options.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    /// <summary>Baglanti ve basit bir sorgu ile veritabani erisimini dogrular.</summary>
    public async Task<bool> IsReachableAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var connection = await OpenAsync(cancellationToken);
            await using var command = new SqlCommand("SELECT 1", connection);
            command.CommandTimeout = 3;
            await command.ExecuteScalarAsync(cancellationToken);
            return true;
        }
        catch (SqlException)
        {
            return false;
        }
    }

    /// <summary>
    /// Portalin gonderdigi imleci sayiya cevirir.
    ///
    /// Imlec Logo LOGICALREF degeridir. Bos veya bozuk imlec SIFIR kabul edilir:
    /// akis bastan baslar. Hata firlatmak, portalin bir kez bozuk imlec
    /// yazmasi halinde kanali kalici olarak kilitlerdi.
    /// </summary>
    public static long ParseCursor(string? cursor) =>
        long.TryParse(cursor, out var value) && value > 0 ? value : 0;

    public int ClampPageSize(int? requested) =>
        Math.Clamp(requested ?? 200, 1, _options.MaxPageSize);
}
