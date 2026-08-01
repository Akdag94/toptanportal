/**
 * ToptanPortal - Gelistirme Ortami Tohum Verisi
 *
 * Uretim ortaminda CALISMAZ (NODE_ENV=production ise reddeder).
 * Beş rolün tamamı için birer hesap açar; böylece Kör Sipariş Modu ve RBAC
 * davranışları elle doğrulanabilir.
 *
 * Hesaplar 2FA ZORUNLU DEĞİLDİR: iki adımlı doğrulama isteğe bağlıdır ve
 * kullanıcı dilerse hesap güvenliği ekranından kendisi etkinleştirir.
 *
 *   pnpm --filter @toptanportal/db seed
 */

import {
  DiscountKind,
  DiscountScope,
  MfaMethod,
  PrismaClient,
  ProductStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

/** Argon2id parametreleri - API tarafindaki CryptoService ile ayni olmalidir. */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'Toptan2026!Portal';

interface SeedUserSpec {
  email: string;
  fullName: string;
  role: UserRole;
  companyKey: string | null;
  mfaRequired: boolean;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Tohum verisi üretim ortamında çalıştırılamaz.');
  }

  const passwordHash = await argon2.hash(SEED_PASSWORD, ARGON2_OPTIONS);

  const tenant = await prisma.tenant.upsert({
    where: { code: 'DEMO' },
    update: {},
    create: {
      code: 'DEMO',
      title: 'Demo Toptan Gıda ve İçecek A.Ş.',
      taxNumber: '1234567890',
      logoFirmNo: 1,
      logoPeriodNo: 1,
    },
  });

  await prisma.auditChainHead.upsert({
    where: { tenantId: tenant.id },
    update: {},
    create: { tenantId: tenant.id },
  });

  await prisma.adminIpWhitelist.upsert({
    where: { tenantId_cidr: { tenantId: tenant.id, cidr: '127.0.0.1/32' } },
    update: { isActive: true },
    create: {
      tenantId: tenant.id,
      cidr: '127.0.0.1/32',
      label: 'Yerel geliştirme makinesi',
    },
  });
  await prisma.adminIpWhitelist.upsert({
    where: { tenantId_cidr: { tenantId: tenant.id, cidr: '::1/128' } },
    update: { isActive: true },
    create: {
      tenantId: tenant.id,
      cidr: '::1/128',
      label: 'Yerel geliştirme makinesi (IPv6)',
    },
  });

  const companySpecs = [
    {
      key: 'KAHVE',
      logoCariCode: '120.01.0001',
      title: 'Mavi Kapı Kahve ve Kahvaltı Ltd. Şti.',
      shortName: 'Mavi Kapı Kahve',
      /* VKN ve vergi dairesi GELISTIRME VERISINDE DE bulunur: e-Belge hatti
         bunlar olmadan calismaz ve "bende fatura kesilmiyor" sorusunun cevabi
         gelistirme ortaminda hic gorulmezdi. Numaralar ornektir. */
      taxNumber: '2960547821',
      taxOffice: 'Kadıköy',
      address: 'Bağdat Cad. No:112',
      city: 'İstanbul',
      district: 'Kadıköy',
      creditLimit: 250000,
      paymentTermDays: 30,
      logoPriceListNo: 3,
    },
    {
      key: 'OTEL',
      logoCariCode: '120.01.0002',
      title: 'Sahil Butik Otel İşletmeciliği A.Ş.',
      shortName: 'Sahil Butik Otel',
      taxNumber: '4180376925',
      taxOffice: 'Çeşme',
      address: 'Sakarya Mah. Liman Sok. No:7',
      city: 'İzmir',
      district: 'Çeşme',
      creditLimit: 750000,
      paymentTermDays: 45,
      logoPriceListNo: 5,
    },
  ];

  const companies = new Map<string, string>();

  for (const spec of companySpecs) {
    const company = await prisma.company.upsert({
      where: {
        tenantId_logoCariCode: { tenantId: tenant.id, logoCariCode: spec.logoCariCode },
      },
      /* Var olan kayit da GUNCELLENIR: `update: {}` birakilsaydi, daha once
         tohumlanmis bir veritabani VKN'siz kalir ve o kurulumda fatura
         kesilemezdi - tohum betigini yeniden calistirmak da bunu duzeltmezdi. */
      update: {
        taxNumber: spec.taxNumber,
        taxOffice: spec.taxOffice,
        address: spec.address,
      },
      create: {
        tenantId: tenant.id,
        logoCariCode: spec.logoCariCode,
        title: spec.title,
        shortName: spec.shortName,
        taxNumber: spec.taxNumber,
        taxOffice: spec.taxOffice,
        address: spec.address,
        city: spec.city,
        district: spec.district,
        creditLimit: spec.creditLimit,
        paymentTermDays: spec.paymentTermDays,
        logoPriceListNo: spec.logoPriceListNo,
        defaultWarehouseNo: 0,
        isEInvoiceUser: true,
      },
    });
    companies.set(spec.key, company.id);
  }

  const userSpecs: SeedUserSpec[] = [
    {
      email: 'admin@toptanportal.local',
      fullName: 'Sistem Yöneticisi',
      role: UserRole.SUPER_ADMIN,
      companyKey: null,
      mfaRequired: false,
    },
    {
      email: 'plasiyer@toptanportal.local',
      fullName: 'Saha Satış Temsilcisi',
      role: UserRole.SALES_REP,
      companyKey: null,
      mfaRequired: false,
    },
    {
      email: 'sahip@mavikapi.local',
      fullName: 'Mavi Kapı - İşletme Sahibi',
      role: UserRole.BUSINESS_OWNER,
      companyKey: 'KAHVE',
      mfaRequired: false,
    },
    {
      email: 'barista@mavikapi.local',
      fullName: 'Mavi Kapı - Barista',
      role: UserRole.BUSINESS_STAFF,
      companyKey: 'KAHVE',
      mfaRequired: false,
    },
    {
      email: 'muhasebe@mavikapi.local',
      fullName: 'Mavi Kapı - Muhasebe',
      role: UserRole.BUSINESS_ACCOUNTANT,
      companyKey: 'KAHVE',
      mfaRequired: false,
    },
    {
      email: 'satinalma@sahilotel.local',
      fullName: 'Sahil Otel - Satın Alma Müdürü',
      role: UserRole.BUSINESS_OWNER,
      companyKey: 'OTEL',
      mfaRequired: false,
    },
    {
      email: 'depo@sahilotel.local',
      fullName: 'Sahil Otel - Depo Sorumlusu',
      role: UserRole.BUSINESS_STAFF,
      companyKey: 'OTEL',
      mfaRequired: false,
    },
  ];

  const createdUsers = new Map<string, string>();

  for (const spec of userSpecs) {
    const emailNormalized = spec.email.trim().toLowerCase();
    const companyId = spec.companyKey ? (companies.get(spec.companyKey) ?? null) : null;

    if (spec.companyKey && !companyId) {
      throw new Error(`Tohum verisi tutarsız: ${spec.companyKey} işletmesi bulunamadı.`);
    }

    const user = await prisma.user.upsert({
      where: { tenantId_emailNormalized: { tenantId: tenant.id, emailNormalized } },
      update: {},
      create: {
        tenantId: tenant.id,
        companyId,
        email: spec.email,
        emailNormalized,
        fullName: spec.fullName,
        passwordHash,
        role: spec.role,
        status: UserStatus.ACTIVE,
        mfaRequired: spec.mfaRequired,
        mfaMethod: spec.mfaRequired ? MfaMethod.TOTP : null,
      },
    });

    createdUsers.set(spec.email, user.id);

    // Alt yetkililer icin varsayilan harcama limiti: her siparis onaya duser.
    if (spec.role === UserRole.BUSINESS_STAFF) {
      await prisma.userSpendingLimit.upsert({
        where: { userId: user.id },
        update: {},
        create: {
          userId: user.id,
          perOrderLimit: 15000,
          dailyLimit: 40000,
          alwaysRequiresApproval: true,
        },
      });
    }
  }

  // Plasiyere her iki cariyi de ata.
  const salesRepId = createdUsers.get('plasiyer@toptanportal.local');
  if (!salesRepId) {
    throw new Error('Tohum verisi tutarsız: plasiyer hesabı oluşturulamadı.');
  }

  for (const companyId of companies.values()) {
    await prisma.salesRepAssignment.upsert({
      where: { salesRepUserId_companyId: { salesRepUserId: salesRepId, companyId } },
      update: { isActive: true, revokedAt: null },
      create: { salesRepUserId: salesRepId, companyId },
    });
  }

  const catalog = await seedCatalog(tenant.id, companies);

  process.stdout.write(
    [
      '',
      'Tohum verisi yüklendi.',
      `  Kiracı      : ${tenant.title} (${tenant.code})`,
      `  İşletme     : ${companies.size}`,
      `  Kullanıcı   : ${createdUsers.size}`,
      `  Ürün        : ${catalog.productCount}`,
      `  Fiyat satırı: ${catalog.priceItemCount}`,
      `  İskonto     : ${catalog.discountCount}`,
      `  Ortak şifre : ${SEED_PASSWORD}`,
      '',
      '  İki adımlı doğrulama isteğe bağlıdır; hiçbir hesap ilk girişte zorlanmaz.',
      '  Süper Admin yalnızca 127.0.0.1 / ::1 adreslerinden giriş yapabilir.',
      '  Barista hesabı Kör Sipariş Modundadır: fiyat ve stok adedi görmez.',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Katalog, stok, fiyat ve iskonto
// ---------------------------------------------------------------------------

interface ProductSpec {
  code: string;
  name: string;
  brand: string;
  categoryPath: string;
  baseUnit: { code: string; name: string };
  /** Ana birim disindaki birimler: 1 birim = kac ana birim */
  packUnits: { code: string; name: string; factor: number; isDefault?: boolean }[];
  vatRate: number;
  /** Ana birimde: genel liste fiyati */
  basePrice: number;
  onHand: number;
  criticalThreshold: number;
  barcodes: { barcode: string; unitCode: string }[];
}

const PRODUCT_SPECS: ProductSpec[] = [
  {
    code: 'KHV-001',
    name: 'Espresso Çekirdek Kahve 1 kg',
    brand: 'Demo Roastery',
    categoryPath: 'İçecek/Kahve/Çekirdek',
    baseUnit: { code: 'ADET', name: 'Adet' },
    packUnits: [{ code: 'KOLI', name: 'Koli (6 adet)', factor: 6, isDefault: true }],
    vatRate: 10,
    basePrice: 420,
    onHand: 480,
    criticalThreshold: 60,
    barcodes: [
      { barcode: '8690000000017', unitCode: 'ADET' },
      { barcode: '18690000000014', unitCode: 'KOLI' },
    ],
  },
  {
    code: 'SUT-001',
    name: 'Tam Yağlı Süt 1 L',
    brand: 'Demo Süt',
    categoryPath: 'Süt Ürünleri/Süt',
    baseUnit: { code: 'ADET', name: 'Adet' },
    packUnits: [{ code: 'KOLI', name: 'Koli (12 adet)', factor: 12, isDefault: true }],
    vatRate: 1,
    basePrice: 32.5,
    onHand: 1440,
    criticalThreshold: 240,
    barcodes: [{ barcode: '8690000000024', unitCode: 'ADET' }],
  },
  {
    code: 'SRP-001',
    name: 'Karamel Aroma Şurubu 700 ml',
    brand: 'Demo Syrup',
    categoryPath: 'İçecek/Aroma Şurupları',
    baseUnit: { code: 'ADET', name: 'Adet' },
    packUnits: [{ code: 'KOLI', name: 'Koli (6 adet)', factor: 6, isDefault: true }],
    vatRate: 20,
    basePrice: 268,
    onHand: 54,
    criticalThreshold: 60,
    barcodes: [{ barcode: '8690000000031', unitCode: 'ADET' }],
  },
  {
    code: 'BRD-001',
    name: 'Ekşi Maya Ekmek 500 g',
    brand: 'Demo Fırın',
    categoryPath: 'Fırın/Ekmek',
    baseUnit: { code: 'ADET', name: 'Adet' },
    packUnits: [{ code: 'KASA', name: 'Kasa (10 adet)', factor: 10, isDefault: true }],
    vatRate: 1,
    basePrice: 42,
    onHand: 0,
    criticalThreshold: 20,
    barcodes: [{ barcode: '8690000000048', unitCode: 'ADET' }],
  },
  {
    code: 'PCT-001',
    name: 'Karton Bardak 8 oz (50\'li)',
    brand: 'Demo Pack',
    categoryPath: 'Sarf/Ambalaj',
    baseUnit: { code: 'PAKET', name: 'Paket' },
    packUnits: [{ code: 'KOLI', name: 'Koli (20 paket)', factor: 20, isDefault: true }],
    vatRate: 20,
    basePrice: 96,
    onHand: 620,
    criticalThreshold: 100,
    barcodes: [{ barcode: '8690000000055', unitCode: 'PAKET' }],
  },
];

async function seedCatalog(
  tenantId: string,
  companies: Map<string, string>,
): Promise<{ productCount: number; priceItemCount: number; discountCount: number }> {
  const warehouse = await prisma.warehouse.upsert({
    where: { tenantId_logoWarehouseNo: { tenantId, logoWarehouseNo: 0 } },
    update: {},
    create: {
      tenantId,
      logoWarehouseNo: 0,
      name: 'Merkez Depo',
      city: 'İstanbul',
      isDefault: true,
    },
  });

  // Genel liste tum carilere; ozel listeler cari kartindaki numaraya baglidir.
  const generalList = await prisma.priceList.upsert({
    where: { tenantId_logoPriceListNo: { tenantId, logoPriceListNo: 1 } },
    update: {},
    create: {
      tenantId,
      logoPriceListNo: 1,
      name: 'Genel Satış Listesi',
      isDefault: true,
      vatIncluded: false,
    },
  });

  const cafeList = await prisma.priceList.upsert({
    where: { tenantId_logoPriceListNo: { tenantId, logoPriceListNo: 3 } },
    update: {},
    create: {
      tenantId,
      logoPriceListNo: 3,
      name: 'Kafe & Kahveci Listesi',
      vatIncluded: false,
    },
  });

  const hotelList = await prisma.priceList.upsert({
    where: { tenantId_logoPriceListNo: { tenantId, logoPriceListNo: 5 } },
    update: {},
    create: {
      tenantId,
      logoPriceListNo: 5,
      name: 'Otel & Zincir Listesi',
      vatIncluded: false,
    },
  });

  let priceItemCount = 0;
  let discountCount = 0;

  for (const [index, spec] of PRODUCT_SPECS.entries()) {
    const product = await prisma.product.upsert({
      where: { tenantId_logoItemCode: { tenantId, logoItemCode: spec.code } },
      update: {},
      create: {
        tenantId,
        logoItemCode: spec.code,
        name: spec.name,
        brand: spec.brand,
        categoryPath: spec.categoryPath,
        baseUnitCode: spec.baseUnit.code,
        baseUnitName: spec.baseUnit.name,
        vatRate: spec.vatRate,
        criticalStockThreshold: spec.criticalThreshold,
        minOrderQuantity: 0,
        status: ProductStatus.PUBLISHED,
        sortOrder: index,
      },
    });

    const baseUnit = await prisma.productUnit.upsert({
      where: { productId_code: { productId: product.id, code: spec.baseUnit.code } },
      update: {},
      create: {
        productId: product.id,
        code: spec.baseUnit.code,
        name: spec.baseUnit.name,
        conversionFactor: 1,
        isBaseUnit: true,
        isDefaultForOrder: spec.packUnits.every((unit) => !unit.isDefault),
        sortOrder: 0,
      },
    });

    for (const [unitIndex, packUnit] of spec.packUnits.entries()) {
      await prisma.productUnit.upsert({
        where: { productId_code: { productId: product.id, code: packUnit.code } },
        update: {},
        create: {
          productId: product.id,
          code: packUnit.code,
          name: packUnit.name,
          conversionFactor: packUnit.factor,
          isBaseUnit: false,
          isDefaultForOrder: packUnit.isDefault ?? false,
          sortOrder: unitIndex + 1,
        },
      });
    }

    for (const barcode of spec.barcodes) {
      await prisma.productBarcode.upsert({
        where: { productId_barcode: { productId: product.id, barcode: barcode.barcode } },
        update: {},
        create: {
          productId: product.id,
          barcode: barcode.barcode,
          unitCode: barcode.unitCode,
        },
      });
    }

    await prisma.stockSnapshot.upsert({
      where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } },
      update: {},
      create: {
        productId: product.id,
        warehouseId: warehouse.id,
        onHand: spec.onHand,
        logoReserved: 0,
        portalReserved: 0,
      },
    });

    // Fiyatlar ANA BIRIMDE tanimlanir; koli fiyati cevrim katsayisiyla turetilir.
    // Kafe listesi %4, otel listesi %7 daha avantajlidir.
    const listPrices: { listId: string; price: number }[] = [
      { listId: generalList.id, price: spec.basePrice },
      { listId: cafeList.id, price: round2(spec.basePrice * 0.96) },
      { listId: hotelList.id, price: round2(spec.basePrice * 0.93) },
    ];

    for (const entry of listPrices) {
      await prisma.priceListItem.upsert({
        where: {
          priceListId_productId_unitId_minQuantity: {
            priceListId: entry.listId,
            productId: product.id,
            unitId: baseUnit.id,
            minQuantity: 0,
          },
        },
        update: {},
        create: {
          priceListId: entry.listId,
          productId: product.id,
          unitId: baseUnit.id,
          price: entry.price,
          minQuantity: 0,
        },
      });
      priceItemCount += 1;
    }

    // Kademeli fiyat ornegi: kahvede 120 adet ve uzeri ek avantaj.
    if (spec.code === 'KHV-001') {
      await prisma.priceListItem.upsert({
        where: {
          priceListId_productId_unitId_minQuantity: {
            priceListId: cafeList.id,
            productId: product.id,
            unitId: baseUnit.id,
            minQuantity: 120,
          },
        },
        update: {},
        create: {
          priceListId: cafeList.id,
          productId: product.id,
          unitId: baseUnit.id,
          price: round2(spec.basePrice * 0.9),
          minQuantity: 120,
        },
      });
      priceItemCount += 1;
    }
  }

  // Genel hacim iskontosu: 240 ana birim ve uzeri %3.
  discountCount += await upsertDiscount({
    tenantId,
    key: 'GLOBAL-VOLUME-240',
    scope: DiscountScope.GLOBAL,
    kind: DiscountKind.LINE_VOLUME,
    minQuantity: 240,
    ratePercent: 3,
    chainOrder: 1,
  });

  // Otel carisine ozel zincirli dip iskonto: %5 + %2 (art arda, kalan tutara).
  const hotelCompanyId = companies.get('OTEL');

  if (hotelCompanyId) {
    discountCount += await upsertDiscount({
      tenantId,
      key: 'OTEL-CHAIN-1',
      scope: DiscountScope.COMPANY,
      kind: DiscountKind.FOOTER_CHAIN,
      companyId: hotelCompanyId,
      minQuantity: 0,
      ratePercent: 5,
      chainOrder: 1,
      logoDiscountCode: 'IND-SOZLESME',
    });
    discountCount += await upsertDiscount({
      tenantId,
      key: 'OTEL-CHAIN-2',
      scope: DiscountScope.COMPANY,
      kind: DiscountKind.FOOTER_CHAIN,
      companyId: hotelCompanyId,
      minQuantity: 0,
      ratePercent: 2,
      chainOrder: 2,
      logoDiscountCode: 'IND-CIRO',
    });
  }

  return { productCount: PRODUCT_SPECS.length, priceItemCount, discountCount };
}

/**
 * Iskonto kuralinda dogal bir benzersizlik anahtari yoktur; tekrar
 * calistirmaya dayanikli olmasi icin `logoDiscountCode` ve kapsam uzerinden
 * aranir, yoksa olusturulur.
 */
async function upsertDiscount(input: {
  tenantId: string;
  key: string;
  scope: DiscountScope;
  kind: DiscountKind;
  companyId?: string;
  minQuantity: number;
  ratePercent: number;
  chainOrder: number;
  logoDiscountCode?: string;
}): Promise<number> {
  const existing = await prisma.discountRule.findFirst({
    where: {
      tenantId: input.tenantId,
      scope: input.scope,
      kind: input.kind,
      companyId: input.companyId ?? null,
      chainOrder: input.chainOrder,
      ratePercent: input.ratePercent,
    },
    select: { id: true },
  });

  if (existing) return 0;

  await prisma.discountRule.create({
    data: {
      tenantId: input.tenantId,
      scope: input.scope,
      kind: input.kind,
      companyId: input.companyId ?? null,
      minQuantity: input.minQuantity,
      ratePercent: input.ratePercent,
      chainOrder: input.chainOrder,
      logoDiscountCode: input.logoDiscountCode ?? null,
    },
  });

  return 1;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nTohum verisi yüklenemedi: ${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
