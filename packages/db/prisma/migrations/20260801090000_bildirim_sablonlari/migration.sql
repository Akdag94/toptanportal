-- ---------------------------------------------------------------------------
-- Kiraci bazli bildirim sablonlari.
--
-- Tablo YALNIZCA UZERINE YAZILAN metinleri tutar; varsayilan metin kodda
-- kalir. Bu yuzden satir yoklugu bir eksiklik degil, "varsayilan yururlukte"
-- anlamina gelir ve kurulumda hicbir satir uretilmez.
-- ---------------------------------------------------------------------------
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "topic" "NotificationTopic" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "subjectTemplate" VARCHAR(200) NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- Konu ve kanal basina TEK metin. Ikinci bir satir, hangisinin gecerli
-- oldugunu gonderim anindaki siralamaya birakirdi.
CREATE UNIQUE INDEX "notification_templates_tenantId_topic_channel_key"
ON "notification_templates"("tenantId", "topic", "channel");

ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_updatedByUserId_fkey"
    FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- KOR MODDAKI ALICIYA ULASAN KONULARDA KONU SATIRI PARASAL DEGISKEN TASIYAMAZ.
--
-- Siparis durumu ve onay bildirimi fiyat GORMEYEN kullaniciya da gider. O
-- alici icin {{tutar}} hic uretilmez; govdede olsa satiri dusurulur, konuda
-- olursa konunun tamami varsayilana doner - yani sablonu yazan kisi
-- yazdigindan baska bir konu satiri gondermis olur. Ayrica konu, bildirim
-- onizlemesinde yani KILIT EKRANINDA gorunur.
--
-- Tahsilat ve vade konularinda ayni kisit YOKTUR: o bildirimler BALANCE_VIEW
-- yetkisi olmayan aliciya zaten hic uretilmez.
--
-- Kural uygulama katmaninda da uygulanir (upsertNotificationTemplateSchema);
-- dogrudan veritabanina baglanan bir arac o katmani atlar.
-- ---------------------------------------------------------------------------
ALTER TABLE "notification_templates" ADD CONSTRAINT "chk_notification_templates_subject_no_money"
    CHECK (
        "topic" NOT IN ('ORDER_STATUS', 'ORDER_APPROVAL_PENDING')
        OR "subjectTemplate" !~ '\{\{\s*tutar\s*\}\}'
    );
