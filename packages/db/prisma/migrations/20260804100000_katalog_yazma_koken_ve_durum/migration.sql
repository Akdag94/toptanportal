-- ---------------------------------------------------------------------------
-- Katalog yazimi: kart kokeni ve Logo yazma durumu
--
-- Portal bu goc ile Logo'ya YAZMAYA baslar. Iki yeni bilgi tasinir:
--
--   1. Kartin nerede DOGDUGU (origin). Hangi alanlarin portalden
--      duzenlenebilecegini bu belirler.
--   2. Portalde yapilan degisikligin Logo'ya ULASIP ULASMADIGI
--      (logoWriteState). Bu alan olmadan ekran yalan soyler: kullanici
--      fiyati degistirir, ekranda yeni fiyati gorur ve isinin bittigini
--      sanir - Logo'ya yazim ise kuyrukta beklemekte ya da reddedilmis
--      olabilir.
-- ---------------------------------------------------------------------------

CREATE TYPE "ProductOrigin" AS ENUM ('LOGO', 'PORTAL');

CREATE TYPE "LogoWriteState" AS ENUM ('SYNCED', 'PENDING', 'FAILED');

ALTER TYPE "SyncChannel" ADD VALUE 'CATALOG_WRITE';

-- Var olan kartlarin tamami Logo'dan gelmistir: portal bugune kadar kart
-- acamiyordu. Varsayilanin LOGO olmasi, mevcut kartlarin kimlik alanlarini
-- portal duzenlemesine KAPALI tutar - dogru olan da budur.
ALTER TABLE "products"
    ADD COLUMN "origin" "ProductOrigin" NOT NULL DEFAULT 'LOGO',
    ADD COLUMN "logoWriteState" "LogoWriteState" NOT NULL DEFAULT 'SYNCED',
    ADD COLUMN "logoWriteError" VARCHAR(1000);

ALTER TABLE "price_list_items"
    ADD COLUMN "logoWriteState" "LogoWriteState" NOT NULL DEFAULT 'SYNCED',
    ADD COLUMN "logoWriteError" VARCHAR(1000);

-- Operatorun ilk baktigi liste "Logo'ya yazilamayanlar"dir; bu tarama tum
-- katalogu okumamalidir.
CREATE INDEX "products_tenantId_logoWriteState_idx"
    ON "products"("tenantId", "logoWriteState");

CREATE INDEX "price_list_items_logoWriteState_idx"
    ON "price_list_items"("logoWriteState");

-- ---------------------------------------------------------------------------
-- STOK KODU DEGISTIRILEMEZ.
--
-- Kod, Logo tarafindaki birincil anahtardir. Degistirmek, Logo'da yeni bir
-- kart acip eskisini sahipsiz birakmakla ayni seydir: eski koda bagli tum
-- hareket, fatura ve siparis gecmisi oldugu yerde kalir, portal ise baska bir
-- karti gosterir. Iki taraf ayni urunu farkli anahtarla tanir ve mutabakat
-- imkansizlasir.
--
-- Kural uygulama katmaninda da uygulanir (guncelleme semasinda kod alani
-- yoktur); tetikleyici, dogrudan veritabanina baglanan bir aracin ayni hatayi
-- yapmasini engeller. Kod yanlis girildiyse kart ARSIVLENIR ve yenisi acilir -
-- geri alinamayan bir islemin dogru yolu budur.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_product_code_change()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."logoItemCode" IS DISTINCT FROM OLD."logoItemCode" THEN
        RAISE EXCEPTION
            'Stok kodu degistirilemez (% -> %). Karti arsivleyip yeni kod ile yeni kart aciniz.',
            OLD."logoItemCode", NEW."logoItemCode"
            USING ERRCODE = 'check_violation';
    END IF;

    -- Koken de degismez: Logo'da acilmis bir kart, portalden guncellendi diye
    -- portalin mali olmaz.
    IF NEW."origin" IS DISTINCT FROM OLD."origin" THEN
        RAISE EXCEPTION 'Stok kartinin kokeni degistirilemez.'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_code_immutable
    BEFORE UPDATE ON "products"
    FOR EACH ROW
    EXECUTE FUNCTION prevent_product_code_change();

-- ---------------------------------------------------------------------------
-- LOGO'DA KARSILIGI OLMAYAN KART YAYINA ALINAMAZ.
--
-- Portalde acilmis bir kart, ilk basarili yazima kadar Logo'da YOKTUR.
-- Katalogda yayinda birakmak, bayinin siparis verebilecegi ama Logo'ya hicbir
-- zaman dusemeyecek bir urun gostermektir; siparis kuyruga girer, "bulunmayan
-- stok karti" diye olu isaretlenir ve musteri bunu ancak mal gelmeyince
-- ogrenir.
--
-- Kosul YAZMA DURUMUNA degil, LOGO REFERANSINA baglanir. Yazma durumu gecicidir:
-- Logo'da coktan var olan bir kartin ad guncellemesi reddedildiginde durum
-- FAILED olur - ama kart yerinde durmaktadir ve satisi surmelidir. Kisiti
-- duruma baglamak, calisan bir urunu katalogdan dusurmeye zorlardi.
--
-- Logo kokenli kartlarda referans senkron tarafindan doldurulmamis olabilir;
-- onlarin Logo'da var oldugu zaten kokeninden bilinir.
-- ---------------------------------------------------------------------------
ALTER TABLE "products" ADD CONSTRAINT "chk_products_published_requires_logo"
    CHECK (
        "status" <> 'PUBLISHED'
        OR "origin" = 'LOGO'
        OR "logoItemRef" IS NOT NULL
    );
