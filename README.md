# ToptanPortal

HoReCa (otel, restoran, kafe) sektörüne tedarik yapan toptancılar için B2B e-ticaret ve müşteri portalı. Bayiler cari hesaplarını yönetir, kendilerine özel matris fiyatlarla 7/24 sipariş verir; saha satış temsilcileri portföylerini yönetir; arka planda Logo ERP (Go Wings / Tiger 3 / Enterprise) ile çift yönlü entegrasyon çalışır.

---

## Mimari

```
apps/
  api/          NestJS 10 · REST API · RBAC · Kör Sipariş kalkanı · yasal delil loglaması
  web/          Next.js 15 · yönetim, muhasebe ve plasiyer arayüzü
  ios/          SwiftUI · barista, depo ve saha uygulaması
  logo-bridge/  .NET 8 · şirket içi (on-prem) Logo köprüsü — mTLS ile bağlanır
packages/
  contracts/    Roller, yetkiler, Zod şemaları · web ve API'nin ortak sözleşmesi
  db/           Prisma şeması, sertleştirme betikleri, denetim zinciri doğrulayıcı
```

**Neden ayrı bir köprü servisi:** Logo ERP sunucusu asla genel internete açılmaz. Bulut tarafındaki API, şirket içindeki köprüye yalnızca karşılıklı sertifika doğrulaması (mTLS) yapılan bir tünel üzerinden erişir; köprü de yerel ağdaki MSSQL ve Logo Object Service ile konuşur.

---

## Kurulum

Gereksinimler: Node.js 20.11+, pnpm 9+, Docker.

```bash
pnpm install
cp .env.example .env          # anahtarları doldurun (aşağıya bakın)
pnpm infra:up                 # PostgreSQL 16 + Redis 7
pnpm db:migrate               # şema + sertleştirme
pnpm db:seed                  # geliştirme kullanıcıları
pnpm dev:api                  # http://localhost:3001  (dokümantasyon: /api/docs)
pnpm dev:web                  # http://localhost:3000
```

### Anahtar üretimi

```bash
openssl rand -base64 64   # JWT_ACCESS_SECRET
openssl rand -base64 32   # FIELD_ENCRYPTION_KEYS içindeki anahtar (32 bayt olmalı)
openssl rand -base64 32   # BLIND_INDEX_KEY
```

Uygulama, üretim ortamında `CHANGE_ME` içeren bir anahtarla veya IP beyaz listesi kapalıyken **açılmaz**. Yanlış yapılandırmayla ayakta kalmak, hiç ayağa kalkmamaktan risklidir.

### Tohum verisi hesapları

Ortak şifre: `Toptan2026!Portal` (`SEED_PASSWORD` ile değiştirilebilir)

| E-posta | Rol | Not |
|---|---|---|
| `admin@toptanportal.local` | Süper Admin | 2FA zorunlu · yalnızca `127.0.0.1` / `::1` |
| `plasiyer@toptanportal.local` | Satış Temsilcisi | İki bayiye atanmış |
| `sahip@mavikapi.local` | İşletme Ana Yetkilisi | 2FA zorunlu |
| `barista@mavikapi.local` | İşletme Alt Yetkilisi | **Kör Sipariş Modu** |
| `muhasebe@mavikapi.local` | İşletme Muhasebecisi | 2FA zorunlu · sipariş veremez |

---

## Uygulanmış modüller

### Rol tabanlı yetkilendirme (RBAC)

Kararlar rol üzerinden değil **yetki** üzerinden verilir (`packages/contracts/src/permissions.ts`). Rol türevleri eklendiğinde denetleyici kodu değişmez.

| Rol | Fiyat | Bakiye | Sipariş | Evrak |
|---|---|---|---|---|
| Süper Admin | ✓ | ✓ | görüntüler / iptal eder | ✓ |
| Satış Temsilcisi | ✓ | ✓ | bayi adına girer | — |
| İşletme Ana Yetkilisi | ✓ | ✓ | girer / onaylar | ✓ |
| İşletme Alt Yetkilisi | — | — | **yalnızca onaya gönderir** | — |
| İşletme Muhasebecisi | ✓ | ✓ | **giremez** | ✓ |

### Kör Sipariş Modu

İşletme Alt Yetkilisi hesabında API yanıtlarındaki tüm parasal alanlar sunucu tarafında **silinir** — maskelenmez.

Neden silme: `0.00` veya `***` yazmak alanın varlığını ve dolayısıyla veri modelini sızdırır; ayrıca istemcide yanlışlıkla render edilme riski doğurur. Silme, sızıntı yüzeyini sıfırlar.

Alan sözlüğü `packages/contracts/src/blind-order.ts` içindedir ve hem API hem istemciler aynı listeyi kullanır. Süzgeç son savunma hattıdır; servis katmanı zaten yetkisiz alanları sorgulamamalıdır. Davranış `apps/api/src/common/interceptors/blind-order.interceptor.spec.ts` ile kilitlenmiştir — katalog yanıtına sözlüğe eklenmemiş yeni bir finansal alan girdiğinde testin kırılması beklenir.

### Kimlik doğrulama

- **Erişim jetonu:** 15 dk, imzalı JWT, rol ve oturum kimliği taşır
- **Yenileme jetonu:** 30 gün, opak rastgele değer; veritabanında yalnızca SHA-256 özeti tutulur
- **Rotasyon + yeniden kullanım tespiti:** iptal edilmiş bir yenileme jetonu tekrar sunulursa o giriş zincirindeki tüm oturumlar iptal edilir
- **2FA (TOTP):** Süper Admin, İşletme Ana Yetkilisi ve Muhasebeci için zorunlu; kurtarma kodları Argon2id ile özetlenir
- **Cihaz bağlama:** yenileme jetonu başka bir cihazda kullanılamaz
- **IP beyaz listesi:** Süper Admin için CIDR eşleşmesi; hem girişte hem her istekte denetlenir
- **Argon2id** (m=19 MiB, t=2, p=1) ve bilinmeyen e-postalarda da ödenen sahte doğrulama maliyeti — kullanıcı sayımını (enumeration) engeller

### Yasal delil loglaması (5651 / 5070)

```
hash(n) = SHA256( hash(n-1) || "." || kanonikJSON(kayıt(n)) )
```

- Kiracı başına boşluksuz `seq` sırası; eş zamanlı yazımlar `pg_advisory_xact_lock` ile serileştirilir
- `audit_logs` tablosunda `UPDATE`, `DELETE` ve `TRUNCATE` veritabanı tetikleyicisiyle **engellenir** — uygulama kullanıcısı dahil kimse geçmişi değiştiremez
- Finansal aksiyonlarda log yazımı iş verisiyle **aynı işlemde** yapılır: log yazılamıyorsa işlem de tamamlanmaz
- Zincir denetimi: `pnpm --filter @toptanportal/db verify-audit` (günlük cron ve delil sunumu öncesi çalıştırılır)
- Sorgulama ekranı: `/panel/denetim` (yalnızca Süper Admin). Üst şeritte zincirin son halkası (sıra numarası + özet) durur — delil sunan kişi, ekrandaki kayıtların hangi zincir noktasına kadar doğrulandığını bilmelidir. Ekran bir **gözetim** aracı değil delil sunum aracıdır; yetkinin dar tutulmasının sebebi budur.

### KVKK

- Telefon gibi kişisel alanlar AES-256-GCM ile şifreli tutulur (`*_enc`), arama için HMAC-SHA256 blind index kullanılır (`*_idx`)
- Şifreli metne anahtar kimliği gömülüdür; anahtar rotasyonunda eski kayıtlar yeniden şifrelenmeden okunur
- Denetim kaydı `payload` alanı; şifre, jeton, TOTP anahtarı ve kart verisi gibi alanları yazmadan önce maskeler

### Kullanıcı yönetimi

Ekran `/panel/kullanicilar`. İşletme ana yetkilisi yalnızca kendi işletmesinin kullanıcılarını yönetir (`USER_MANAGE_COMPANY`), Süper Admin tümünü (`USER_MANAGE_ALL`). Kapsam sorguya girer, sonradan süzülmez.

- **Yetki yükseltme engellenir:** kimse kendi rolünden geniş yetkili bir rol açamaz. İşletme yetkilisi toptancı tarafı rollerini (Süper Admin, Plasiyer) açabilseydi kendine bir plasiyer hesabı açıp *tüm* bayilerin portföyünü görürdü — bu, rol sisteminin tamamını anlamsız kılar.
- **Geçici şifreyi sunucu üretir.** Yöneticinin belirlediği bir şifre, kullanıcının şifresini bilen ikinci bir kişi demektir; o hesapla yapılan işlemin kime ait olduğu tartışmalı hale gelir ve denetim kaydının delil değeri düşer.
- **Askıya alma açık oturumları da kapatır.** Yalnızca durumu değiştirmek, erişimi jeton süresi dolana kadar sürdürürdü — işten çıkarılan bir kullanıcı için bu süre çok uzundur.
- **Harcama limiti kullanıcı bazındadır** ve işletmenin risk limitinden ayrıdır: bir barista sipariş verebilir ama 50.000 TL'lik sipariş veremez.

### Toplu sipariş (Excel / yapıştırma)

Ekran `/panel/toplu-siparis`, uç `POST /cart/bulk-import`. Bayilerin çoğu sipariş listesini hâlâ Excel'de tutar; bu akış portalin benimsenmesini çalışma alışkanlığının değişmesine bağlı olmaktan çıkarır. Hem dosya sürükleme hem doğrudan yapıştırma desteklenir — kullanıcıların çoğu hücreleri kopyalar, dosyayı kaydetmez.

- **Ayraç** noktalı virgül, virgül veya sekme olabilir; birim dosyada taşınmaz, ürünün sipariş birimi (genelde koli) varsayılır.
- **`1.250` bin iki yüz ellidir.** Bir virgül iki yüz elli okumak siparişi 1000 kat küçültür ve bunu kimse dosyayı yüklerken fark etmez. Ayrımı son ayraçtan sonraki hane sayısı belirler: iki veya daha az hane → ondalık, fazlası → binlik.
- **Başlık satırı sessizce atlanır** (`Stok Kodu;Adet` yazan satır kullanıcının hatası değil alışkanlığıdır); okunamayan *diğer* satırlar satır numarasıyla raporlanır.
- **Aynı kod iki satırda geçiyorsa miktarlar toplanır.** Son satırı kazanan bir mantık, siparişin bir kısmını sessizce düşürürdü.
- Sonuç raporu eksiksizdir: kaç satır okundu, kaçı sepete girdi, hangileri eşleşmedi. "37 kalem eklendi" demek yetmez — kullanıcı 40 satır yüklediğini bilir ve eksiği aramak zorunda kalmamalıdır.
- Kurallar `apps/api/src/cart/bulk-import.service.spec.ts` ile kilitlenmiştir.

### Fiyat listeleri

Ekran `/panel/fiyat-listeleri` (`PRICE_LIST_MANAGE`) **salt okunurdur; düzenleme düğmesi yoktur.** Fiyatlar Logo'dan senkronlanır. Fiyatı portalden değiştirmek, iki sistem arasında hangisinin doğru olduğu belirsiz bir alan yaratır ve bir sonraki senkron o değişikliği sessizce geri alır — kullanıcı da neden geri alındığını asla anlamaz. Ekranın işi fiyatı değiştirmek değil, "bu bayi bu ürünü kaçtan alıyor" sorusunu cevaplamaktır; o soru her gün telefonda sorulur.

### Cari hesap, ekstre ve tahsilat

- **Bakiye hareketlerden yeniden hesaplanır.** `companies` tablosundaki bakiye alanları yalnızca sipariş risk kalkanının hızlı okuması için tazelenen bir önbellektir; ekstre ve özet her zaman hareketlerden türetilir.
- **Yürüyen bakiye SQL pencere fonksiyonuyla üretilir.** Uygulamada toplamak sayfalamayla bağdaşmaz: ikinci sayfa dönem başı devrini kaybeder ve sessizce yanlış bakiye gösterir.
- **Yaşlandırma kova sınırları sabittir** (`Vadesi Gelmemiş`, `1-30`, `31-60`, `61-90`, `90+`) ve kiracı bazında değiştirilemez — muhasebe raporlaması karşılaştırılabilir kalmalıdır.
- **Tahsilat yöntemi onay ihtiyacını belirler:** kredi kartı ve DBS doğrudan işlenir; nakit, çek ve senet fiziksel teslim gerektirdiği için `PENDING` doğar ve kaydı giren kişi kendi kaydını onaylayamaz.
- **Dağıtım varsayılan olarak FIFO'dur:** vadesi en eski açık belgeden başlanır, dağıtılamayan kısım avans olarak kalır.
- Ekstre `Excel (CSV) İndir` düğmesiyle dışa aktarılır. Dosya **noktalı virgülle** ayrılır ve **BOM** ile başlar (Türkçe Excel virgülü ondalık ayracı sayar, BOM'suz UTF-8'i yerel kod sayfasıyla okur); `=`, `+`, `-`, `@` ile başlayan hücreler formül enjeksiyonuna karşı etkisizleştirilir. Kurallar `apps/web/src/lib/ekstre-csv.spec.ts` ile kilitlenmiştir.

### Saha yönetimi — portföy, ziyaret, hedef

- **Plasiyer yalnızca kendisine atanmış bayileri görür.** Kapsam `SalesRepAssignment` üzerinden sunucuda çizilir; istemcinin gönderdiği hiçbir süzgeç kapsamı *genişletemez*. Portföy ticari bir sınırdır.
- **Ziyaret notu silinemez ve metni değiştirilemez** (veritabanı tetikleyicisi). Bir şikâyet kaydının sonradan yok olması, müşteri ilişkisinin geçmişini yeniden yazmaktır; düzeltme yeni bir notla yapılır. Takip tarihi değiştirilebilir — o bir *plandır*, kayıt değil.
- **Prim iki şarta bağlıdır:** ciro yalnızca onaylanmış siparişlerden sayılır *ve* prim tahsil edilen tutar oranında ödenir. Primi ciro üzerinden ödemek, plasiyeri ödeme gücü olmayan bayiye satmaya teşvik eder.
- Ciro, plasiyerin **portföyündeki** bayilerin siparişlerinden gelir — siparişi kimin girdiğinden değil. Aksi hâlde portalin benimsenmesi plasiyerin çıkarına aykırı olurdu.
- Gerçekleşen ciro önbelleklenmez; her okumada hesaplanır.

### e-Fatura / e-İrsaliye arşivi

**PDF asıl belge değildir.** Hukuki asıl, UBL-TR 1.2 biçimindeki imzalı XML'dir; PDF ondan türetilmiş görüntüleme kopyasıdır. İhtilafta mahkemeye XML sunulur, bu yüzden arşiv XML üzerine kurulur ve ikisi çelişirse doğru olan XML'dir.

- **Belgeler veritabanında değil, nesne deposunda durur.** Tabloda yalnızca yol ve SHA-256 özeti vardır — 10 yıllık XML'i veritabanında taşımak felaket kurtarmayı saatlerden günlere çıkarır.
- **Silme yoktur** (VUK 253: 10 yıl saklama). Silme ve tutar değişikliği **veritabanı tetikleyicisiyle** engellenir; uygulama katmanındaki bir kontrol, yeni bir sorguyla veya doğrudan bağlanan bir araçla atlanabilir. Yalnızca *durum* ilerleyebilir — tutar düzeltmesi iade faturasıyla yapılır.
- **`ACCEPTED` ile `DELIVERED` ayrıdır.** e-Fatura'da alıcının reddetme hakkı vardır; ikisini tek duruma indirmek reddedilmiş bir faturayı tahsil edilebilir göstermek olur.
- **İndirme iki adımlıdır:** oturumlu istek kısa ömürlü *imzalı* bağlantı alır, tarayıcı o bağlantıya gider. Bağlantı indiren kişiyi içinde taşır; erişim kaydı bu sayede oturumsuz uçtan da yazılır ve `e_document_access` tablosu append-only'dir.
- **Belge yolu her okumada köke göre çözülür**; dışarı taşan istek reddedilir (`apps/api/src/einvoice/document-storage.service.spec.ts`).
- Toplu indirmede tek bir zip üretilmez — 500 belgeyi bellekte paketlemek eş zamanlı iki talepte sunucuyu tüketir; ayrı bağlantılar tarayıcının indirme yöneticisine devredilir.

### Sanal POS (3D Secure) ve DBS

**Kart verisi portale hiç ulaşmaz.** Kullanıcı bankanın 3D sayfasına yönlendirilir ve kartını oraya girer; portalin gördüğü tek şey bankanın döndüğü sonuç ve maskeli karttır (`454671******7894`). Kart verisi sunucudan bir kez geçerse o sunucu logları, yedekleri ve bellek dökümleriyle birlikte PCI-DSS kapsamına girer — kapsam dışında kalmanın tek güvenilir yolu veriyi hiç görmemektir.

- **Geri dönüş ucunda oturum yoktur** (`POST /pos/callback/:tenantCode`, `@Public()`); banka jeton taşıyamaz. Kimlik doğrulamasının yerini mağaza anahtarıyla hesaplanan **özet** alır ve özeti tutmayan yanıt hiçbir kaydı değiştirmez, yalnızca denetim izi bırakır.
- **Tutar her zaman veritabanından okunur.** Bankadan dönen parametreler kullanıcının tarayıcısından geçer; oradaki tutara güvenmek 1 TL ödeyip 10.000 TL'lik borç kapatmanın yoludur.
- **Başarı için iki koşul birlikte aranır:** 3D doğrulaması (`mdStatus`) *ve* banka provizyonu (`Response`). Yalnızca birine bakmak, parası çekilmemiş bir işlemi başarılı saymaktır. Kural `apps/api/src/pos/pos-provider.spec.ts` ile kilitlenmiştir.
- **`NEEDS_REVIEW`**: banka onayladı ama portal tahsilatı yazamadıysa işlem başarısız sayılmaz, insan incelemesine düşer ve kullanıcıya açıkça "yeniden ödeme yapmayın" denir.
- POS yapılandırması **ya tamamdır ya da yoktur**; yarım yapılandırmayla uygulama açılmaz.

**DBS:** vadesi gelen açık belgeler borç dosyası olarak bankaya verilir, banka sonuç dosyası döner. Tutarlar **kuruş** olarak yazılır — ondalık ayracı bankadan bankaya değişir ve yanlış yorumlanan bir ayraç 1.234,56 TL'yi 123.456 TL yapar. Aynı belge açık bir DBS kaydında yalnızca bir kez bulunabilir (kısmi benzersiz indeks): aynı faturayı iki dosyaya koymak bayiden iki kez tahsilat demektir ve geri dönüşü portalin düzeltebileceği bir şey değildir.

### Bildirim (e-posta ve mobil)

Bildirim teknik bir ayrıntı değil **ticari bir sözdür**: "siparişiniz onaylandı" mesajı gitmezse bayi telefona sarılır ve portalin çözdüğü iş operatörün masasına döner. Bu yüzden bildirim, gönderilip gönderilmediği **sorulabilir** bir kayıttır — gönder-ve-unut bir yan etki değil. Ekranlar: `/panel/bildirimler` (tercihler, herkese açık), `/panel/bildirim-kaydi` (gönderim kaydı, `NOTIFICATION_LOG_VIEW`).

- **İşlemsel ileti ile ticari ileti aynı borudan geçmez.** Kampanya iletisi 6563 sayılı kanun gereği İYS izni ister; sipariş bildirimi istemez. Bu modül ticari ileti göndermez — ikisini birleştirmek, izinsiz gönderimi bir yapılandırma hatası kadar yakın hale getirirdi.
- **Kuyruk outbox'tan ayrıdır.** Outbox siparişin Logo'ya ulaşmasını garanti eder; orada biriken bir e-posta hatası sipariş aktarımını geciktirir. Muhasebe sisteminin beklemesi ile bir hatırlatmanın gecikmesi aynı ağırlıkta değildir.
- **Kayıt iş verisiyle aynı işlemde yazılır, gönderim kuyruktan yapılır.** Sağlayıcıya yapılan bir HTTP çağrısı sipariş işlemini posta sunucusunun yanıt süresine bağlar ve kilitleri uzatır.
- **İçerik kuyruğa yazılırken üretilir ve donar.** Gönderim anında yeniden üretmek, aradan geçen sürede değişen bir tutarla (iade faturası, kısmi iptal) kullanıcının bildirilmiş olması gerekenden başka bir mesaj göndermek olurdu. Gönderilmiş kaydın metni ve alıcısı **veritabanı tetikleyicisiyle** kilitlidir.
- **Kör Sipariş Modu posta kutusunda da geçerlidir.** Arayüzde özenle gizlenen tutarın e-postayla sızması gizlemeyi bastan anlamsız kılar; metin alıcının rolüne göre üretilir ve parasal konular (tahsilat, vade) `BALANCE_VIEW` yetkisi olmayana **hiç üretilmez** — "vadesi geçen belgeniz var" cümlesi tek başına da ticari bilgidir. Kural `apps/api/src/notification/notification-template.spec.ts` ile kilitlenmiştir.
- **Güvenlik ve onay bekleyen sipariş konuları kapatılamaz.** Hesabı ele geçirilen kullanıcının bunu öğrenmesinin tek yolu güvenlik bildirimidir ve saldırganın ilk işi onu kapatmak olurdu; onay bildirimi kapatıldığında ise zarar kullanıcıya değil, siparişi bekleyen bayiye olur (bekleyen siparişin stoğu rezervedir).
- **Geçersiz adres kalıcı hatadır** ve deneme hakkını tüketmeden kapatılır: altı kez denemek sağlayıcı nezdinde gönderen itibarını düşürür ve *geçerli* adreslere giden mesajları da istenmeyen klasörüne iter. Geçici hata (ağ, 5xx, 429) üstel geri çekilmeyle tekrarlanır.
- **Gönderilmeyen kayıt da yazılır.** "Bu bayiye vade hatırlatması gitti mi?" sorusunun cevabı "hayır, tercihi kapalıydı" olabilir; cevapsız kalamaz.
- **Vade hatırlatması belge başına değil bayi başına** üretilir (dört ayrı e-posta, hatırlatmayı spam'e çevirir ve bir sonrakini okunmadan sildirir), günde bir kez gönderilir ve yerel saat 09:00–20:00 dışına ertelenir. Bloke bayiye otomatik hatırlatma gitmez — blokaj insan kararıdır ve yürüyen bir görüşme vardır.
- **Mobil jeton kayıtta durmaz:** kuyrukta SHA-256 özeti tutulur, gerçek jeton gönderim anında cihaz kaydından çözülür; cihaz iptal edilmişse mesaj gönderilmez.
- Üretimde `MAIL_API_URL` / `MAIL_API_KEY` / `MAIL_FROM` eksikse uygulama **açılmaz**. Bildirim gönderemeyen bir portal, güvenlik uyarısını da gönderemez.

### Logo ERP entegrasyon katmanı

Bulut API ile şirket içindeki Logo arasında yalnızca **mTLS ile korunan bir tünel** vardır ve **bağlantıyı her zaman bulut başlatır** — şirket içi ağda dışarıdan erişilebilen bir uç bulunmaz. Köprü yalnızca yanıt verir, buluta hiç çağrı yapmaz.

| Kanal | Yön | Varsayılan sıklık |
|---|---|---|
| Stok | Logo → portal | 2 dk |
| Cari hareket | Logo → portal | 15 dk |
| Fiyat | Logo → portal | 30 dk |
| Sipariş | portal → Logo | 30 sn |

- **İmleç, zaman damgası değil Logo değişiklik sırasıdır.** Sistem saatleri birkaç saniye kaydığında zaman damgasıyla ilerleyen bir akış, o aralıktaki kayıtları sessizce atlar; atlanan kayıt fark akışında bir daha gelmez.
- **Hata sınıflandırması** aktarımın merkezindedir: ağ / zaman aşımı / 5xx **geçicidir** (tekrar denenir, sipariş kuyrukta kalır), 4xx iş kuralı hatası **kalıcıdır** (olay ölü işaretlenir, operatöre düşer). Ayrım yapılmazsa ya kalıcı hata kuyruğu tıkar ya da geçici hata sipariş kaybettirir.
- **Sipariş aktarımı `portalOrderId` üzerinden idempotenttir.** Ağ zaman aşımında "gönderdim mi?" sorusu cevapsızdır; tekrar denemek bu yüzden zorunlu, güvenli olması da köprünün idempotentliğine bağlıdır.
- **`portalReserved` Logo verisiyle asla ezilmez** — o alan portalin kendi rezervasyonlarıdır; ezilirse henüz Logo'ya yansımamış siparişlerin stoğu ikinci kez satılır.
- Cari hareketler `logoFicheRef` ile eşleştirilir; belge numarası Logo'da dönem içinde tekrar edebilir.
- Fiş türü eşlemesi (`account-sync.service.ts`) Tiger / Go Wings varsayılanlarına göre yazılmıştır ve **her kurulumda müşterinin fiş türleriyle doğrulanmalıdır**.
- Durum ekranı: `/panel/entegrasyon` (yalnızca `INTEGRATION_MANAGE`). Kanal açma/kapama, elle tur, tam senkron ve ölü olayları yeniden kuyruğa alma buradan yapılır.

Bu modülün hiçbir görünümü Kör Sipariş Modundaki kullanıcıya ulaşmaz: ilgili uç noktalar `BALANCE_VIEW` / `STATEMENT_VIEW` / `AGING_REPORT_VIEW` yetkisi ister ve alt yetkili rolünde bu yetkiler yoktur. Yanıt süzgeci burada ikinci savunma hattıdır.

---

## Bilinen ödünler

**Web'de yenileme jetonu `localStorage`'da tutulur.** Sayfa yenilendiğinde oturumun sürmesini sağlar; XSS durumunda jetonu açık hale getirir. Üretimde tercih edilen model, jetonu `httpOnly` çerezde tutan bir BFF katmanıdır (Next.js route handler). `apps/web/src/lib/api-client.ts` bu geçişte çağıran kodun değişmeyeceği şekilde tasarlandı.

**Geçersiz jetonlu istekler hız sınırlamasından önce reddedilir.** Muhafız sırası `JwtAuthGuard → RateLimitGuard` olduğu için jeton kaba kuvveti bu katmanda sayılmaz; JWT doğrulaması ucuzdur ve hacimsel savunma Cloudflare tarafındadır. Kullanıcı bazlı sayaçların çalışabilmesi için bu sıra gereklidir.

**Redis erişilemezken oturum iptal denetimi veritabanına düşer.** Erişilebilirlik uğruna iptal edilmiş bir oturumun geçmesine izin verilmez; gecikme artar, güvenlik azalmaz.

---

## iOS uygulaması

Kaynaklar `apps/ios/ToptanPortal/` altındadır ve bir Xcode uygulama hedefine eklenir (iOS 17+, Swift 5.9+).

`Info.plist` gereksinimleri:

```xml
<key>TOPTANPORTAL_API_URL</key>
<string>https://api.toptanportal.com</string>
<key>NSFaceIDUsageDescription</key>
<string>Kayıtlı oturumunuza güvenli şekilde erişmek için kullanılır.</string>
```

**Uygulanmış ekranlar:** rutin sipariş şablonları (10 saniye akışı), barkodla hızlı sepete ekleme, sepet ve sipariş gönderimi, saha ekranı (bayi listesi + tahsilat + ziyaret notu).

**Çevrimdışı kuyruk (`Core/CevrimdisiKuyruk.swift`):** depo bodrumdadır, soğuk hava deposunda sinyal yoktur, plasiyer bayinin deposunda çalışır — bu uygulamanın kullanıldığı yerlerde internet bir varsayım değildir. Sipariş, tahsilat ve ziyaret notu diske yazılır ve bağlantı geldiğinde sırayla gönderilir:

- Her işlemin idempotency anahtarı **oluşturulurken** üretilir; gövde de o anda kodlanır. Gövdeyi gönderim anında yeniden üretmek, aradan geçen sürede değişen bir fiyatla kullanıcının onayladığından farklı bir sipariş göndermek olurdu.
- Kalıcı hata (4xx) alan kayıt **silinmez**, "elle bakılacak" olarak kullanıcıya gösterilir — o sipariş gerçek bir ticari niyettir.
- Kuyruk atomik yazılır; iOS uygulamayı arka planda her an sonlandırabilir.

**Barkod:** kamera açılınca tarama hemen başlar ("tara" düğmesi yok), aynı kod 2 saniye içinde tekrar okunmaz ve barkod bir birime aitse o birim seçili gelir — koli barkodunda "adet" seçili kalması depoda 12 kat yanlış miktar demektir.

Tasarım ilkeleri: birincil eylemler ekranın alt şeridinde sabit durur (bir eliyle mal taşıyan kullanıcının başparmak bölgesi), dokunma hedefleri ≥ 44 pt, birincil düğmeler 56 pt. Renkler sistem semantik renklerinden gelir; aydınlık ve karanlık mod ek kod olmadan çalışır. Yenileme jetonu yalnızca Anahtar Zincirinde, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` sınıfıyla saklanır — yedeklerle başka cihaza taşınmaz.

---

## Sıradaki modüller

1. **e-Belge üretim hattı** — entegratör bağlantısı, UBL-TR üretimi, GİB durum takibi (arşiv ve sunum tarafı hazır)
2. **On-prem köprünün saha sertleştirmesi** — iskelet hazır (`apps/logo-bridge`); Logo Object Service çağrıları müşteri kurulumunda doğrulanacak
3. **Xcode proje hedefi** — iOS kaynakları hazır; `.xcodeproj` oluşturulup CI'a bağlanacak
4. **Bildirim şablon yönetimi** — metinler koda gömülüdür; kiracı bazında düzenleme ekranı sonraki adımdır

Tamamlananlar: stok rezervasyonu ve sipariş motoru, matris fiyat ve kademeli iskonto, cari hesap / ekstre / yaşlandırma, tahsilat kaydı, sipariş risk kalkanı, Logo entegrasyonunun bulut tarafı ve köprü iskeleti, 3D Secure sanal POS, DBS, e-Belge arşivi, saha yönetimi, toplu sipariş içe aktarımı, kullanıcı yönetimi, denetim kaydı sorgulama, bildirim kanalı ve iOS uygulamasının çekirdek akışları.

Temel altyapı (`OutboxEvent`, `IdempotencyKey`, denetim zinciri) bu modüller için şemada hazırdır.

---

## Komutlar

| Komut | Açıklama |
|---|---|
| `pnpm infra:up` / `infra:down` | PostgreSQL + Redis |
| `pnpm db:migrate` | Şema geçişi + sertleştirme |
| `pnpm db:seed` | Geliştirme verisi |
| `pnpm --filter @toptanportal/db verify-audit` | Denetim zinciri bütünlük kontrolü |
| `pnpm --filter @toptanportal/api test` | API testleri |
| `pnpm build` | Tüm paketleri derle |
