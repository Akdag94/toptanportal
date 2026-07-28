-- ToptanPortal - Kopru idempotency tablosu
--
-- Logo'nun KENDI tablolarina dokunulmaz; bu tablo koprunun kendi kaydidir.
-- Logo semasina sutun eklemek, Logo surum yukseltmelerinde kaybolur veya
-- yukseltmeyi engeller.
--
-- Tablonun tek isi su soruyu cevaplamaktir: "bu portal siparisini daha once
-- Logo'ya yazdim mi?" Cevap benzersiz kisitla garanti altindadir - iki es
-- zamanli istek ayni siparisi iki fis olarak yazamaz.

IF OBJECT_ID('dbo.PORTAL_ORDER_MAP', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.PORTAL_ORDER_MAP
    (
        PortalOrderId     UNIQUEIDENTIFIER NOT NULL,
        PortalOrderNumber NVARCHAR(24)     NOT NULL,
        LogoOrderNumber   NVARCHAR(32)     NOT NULL,
        LogoReference     INT              NOT NULL,
        TransferredAt     DATETIME2(3)     NOT NULL CONSTRAINT DF_PORTAL_ORDER_MAP_TransferredAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT PK_PORTAL_ORDER_MAP PRIMARY KEY CLUSTERED (PortalOrderId)
    );

    -- Logo fisinden portal siparisine geri bakis: muhasebeci Logo'da bir fis
    -- gorup "bu hangi portal siparisi?" diye sorar.
    CREATE UNIQUE INDEX UX_PORTAL_ORDER_MAP_LogoReference
        ON dbo.PORTAL_ORDER_MAP (LogoReference);

    CREATE INDEX IX_PORTAL_ORDER_MAP_PortalOrderNumber
        ON dbo.PORTAL_ORDER_MAP (PortalOrderNumber);
END;
GO

-- Kopru kullanicisinin yetkileri: okuma her yerde, yazma YALNIZCA bu tabloda.
--
-- Kopru Logo tablolarina yazamaz. Siparis yazimi Logo'nun kendi servis
-- katmanindan gecer; koprunun veritabani kullanicisina INSERT yetkisi vermek,
-- ileride "hizli cozum" diye dogrudan fis yazmanin onunu acar.
-- GRANT SELECT ON SCHEMA::dbo TO portal_bridge;
-- GRANT INSERT, SELECT ON dbo.PORTAL_ORDER_MAP TO portal_bridge;
