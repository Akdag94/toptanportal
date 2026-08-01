# ToptanPortal Logo Köprüsü

Şirket içinde (on-prem) çalışan .NET 8 servisi. Buluttaki portal API'si ile Logo ERP arasındaki tek geçittir.

## Temel kural

**Köprü buluta hiç çağrı yapmaz.** Bağlantıyı her zaman bulut başlatır; şirket içi ağda dışarıdan erişilebilen bir uç bulunmaz. Köprü yalnızca gelen isteği yanıtlar.

## Güvenlik

- **mTLS zorunludur.** Kestrel istemci sertifikası ister ve zinciri doğrular; ayrıca `Bridge:AllowedClientThumbprints` listesindeki SHA-256 parmak izlerine karşı sabit zamanlı karşılaştırma yapılır. Geçerli bir sertifika yetmez — listede olması gerekir, çünkü aynı CA başka sertifikalar da imzalayabilir.
- **Veritabanı kullanıcısı salt-okunurdur.** Tek istisna `PORTAL_ORDER_MAP` tablosudur (bkz. `sql/portal_order_map.sql`).
- **Logo fiş tablolarına doğrudan INSERT yapılmaz.** ORFICHE/ORFLINE'a elle satır yazmak Logo'nun numaralama, stok hareketi ve muhasebe bağlantısı mantığını atlar; kayıt görünür ama dönem sonunda tutmaz. Sipariş yazımı Logo'nun kendi servis katmanına devredilir (`ILogoOrderSink`).

## Uçlar

| Uç | İş |
|---|---|
| `GET /bridge/v1/health` | Köprü, Logo **veritabanı** ve Logo **servisi** ayrı raporlanır |
| `GET /bridge/v1/diagnostics` | Kurulum doğrulaması: tablo, kolon, dönem ve servis erişimi |
| `GET /bridge/v1/stock` | Stok fark akışı (dönen tarama) |
| `GET /bridge/v1/prices` | Satış fiyatı fark akışı |
| `GET /bridge/v1/accounts` | Cari hareket fark akışı (ileriye akar) |
| `POST /bridge/v1/orders` | Sipariş yazımı — `portalOrderId` üzerinden idempotent |

Hata sözleşmesi: **422 kalıcıdır** (portal olayı ölü işaretler, operatör müdahale eder), **5xx geçicidir** (portal tekrar dener). Bu ayrım yanlış verilirse ya kuyruk tıkanır ya sipariş kaybolur.

## Akış tasarımı

- **Stok:** Logo'da stok toplamları için değişiklik damgası yoktur. Akış `LOGICALREF` üzerinde dönen bir taramadır; sona gelince imleç sıfırlanır ve baştan başlar. "Değişti mi" sorusunu soramadığımız için "hepsini dolaş" cevabını veririz.
- **Fiyat:** Sıralama `CAPIBLOCK_MODIFIEDDATE`, imleç `LOGICALREF`. Aynı saniyede değişen iki kartın biri tarih imleciyle atlanırdı. Yalnızca satış fiyatları (`PTYPE = 2`) taşınır — alış fiyatı portale asla gitmez.
- **Cari hareket:** Kayıtlar eklenir, değiştirilmez (düzeltme ters kayıtla yapılır); imleç ileriye akar, başa dönmez.

## Sahada koruma

- **Eşzamanlılık sınırı** (`Bridge:MaxConcurrentRequests`). Köprü, Logo veritabanını portalin yüküne karşı koruyan taraftır; buluttaki bir döngü hatası sınır olmadan muhasebe sistemini yavaşlatır. Sınır aşıldığında istek **503 + `Retry-After`** ile reddedilir — kuyruğa alınmaz, çünkü kuyrukta bekleyen istek zaten zaman aşımına uğrar ve portal tekrar dener. 503 bulut tarafında **geçici** hata sayılır; sipariş ölü işaretlenmez.
- **Sorgu zaman aşımı** (`Bridge:CommandTimeoutSeconds`). Logo tarafında kilitlenen tek bir tablo, zaman aşımı olmadan köprünün tüm bağlantı havuzunu tüketir ve sağlık ucu dahil hiçbir istek yanıt alamaz.
- **İstek gövdesi 4 MB ile sınırlıdır.** Şirket içi ağdaki gözetimsiz bir servis, sınırsız gövdeyle tek istekte bellek tüketimine açıktır.
- **İstek günlüğü en dışta durur:** reddedilen sertifika ve yoğunluk nedeniyle geri çevrilen istek de kaydedilir. Gövde yazılmaz — sipariş gövdesi cari kodu, ürün ve tutar taşır. Başarılı istekler `Debug` seviyesindedir (`Bridge.Request`), hatalı istekler her zaman görünür.
- **Parmak izi biçimi açılışta denetlenir.** Windows sertifika ekranından kopyalanan 40 karakterlik SHA-1 değeri, kabul edilseydi listeyi hiçbir sertifikayla eşleşmez hale getirir ve hata ancak ilk istekte anlaşılırdı.

## Kurulum doğrulaması

Köprünün sahadaki en sık sorunu tablo ve alan adlarıdır: Tiger 3, Go Wings ve Enterprise arasında farklar vardır, firma/dönem numarası tablo adına gömülüdür ve **dönem yıl sonunda değişir**. Bunlardan biri yanlışsa köprü açılır, sağlıklı görünür ve ilk senkron turunda anlamsız bir SQL hatasıyla durur.

`GET /bridge/v1/diagnostics` bu hatayı kurulum anında ve insan okunur biçimde verir:

```json
{
  "status": "FAIL",
  "failureCount": 1,
  "warningCount": 1,
  "findings": [
    { "target": "LG_001_01_STINVTOT", "status": "PASS", "message": "…erişilebilir (14 kolon)." },
    { "target": "LG_001_PRCLIST", "status": "FAIL", "message": "…beklenen kolonlar yok: UOMREF…" },
    { "target": "period", "status": "WARN", "message": "…dönem 31.12.2025 tarihinde bitmiş…" }
  ]
}
```

Tanılama salt okunurdur, hiçbir şeyi değiştirmez ve hata durumunda istisna atmaz — işi sorunu **raporlamaktır**, kendisi patlamak değil.

## Kurulum

```bash
dotnet restore
dotnet build -c Release
dotnet test                      # yapılandırma, imleç ve sertifika testleri
dotnet run --project ToptanPortal.LogoBridge
```

`sql/portal_order_map.sql` betiği Logo veritabanında bir kez çalıştırılır.

`appsettings.json` içinde doldurulması zorunlu alanlar: `Bridge:ConnectionString`, `Bridge:FirmNumber`, `Bridge:PeriodNumber`, `Bridge:AllowedClientThumbprints`, `Kestrel` sunucu sertifikası. `Bridge:ObjectServiceUrl` boş bırakılırsa **sipariş yazımı kapalıdır** — okuma akışları çalışır, gelen siparişler kalıcı hata alır ve bu durum hem açılış günlüğünde hem `/diagnostics` çıktısında yazar. Eksik veya geçersiz bir değerle servis **açılmaz** — yanlış firma numarasıyla ayağa kalkan bir köprü, başka bir şirketin stok verisini portale taşır.

`Bridge:PeriodNumber` **yıl sonu dönem devrinde değişir**; devir sonrası güncellenmezse köprü kapanan dönemi okumaya devam eder ve yeni siparişleri göremez.

## Sürüm notu

Tablo ve alan adları (`LG_001_01_STINVTOT`, `PRCLIST`, `CLFLINE` …) Logo sürümüne göre değişebilir — Tiger 3, Go Wings ve Enterprise arasında farklar vardır. Kurulumda doğrulanmalıdır; `Features/*Reader.cs` dosyalarındaki SQL bu amaçla tek yerde toplanmıştır.
