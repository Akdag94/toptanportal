/**
 * ToptanPortal - Gelistirme Ortami Tohum Verisi
 *
 * Uretim ortaminda CALISMAZ (NODE_ENV=production ise reddeder).
 * Beş rolün tamamı için birer hesap açar; böylece Kör Sipariş Modu ve RBAC
 * davranışları elle doğrulanabilir.
 *
 *   pnpm --filter @toptanportal/db seed
 */

import { PrismaClient, UserRole, UserStatus, MfaMethod } from '@prisma/client';
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
      update: {},
      create: {
        tenantId: tenant.id,
        logoCariCode: spec.logoCariCode,
        title: spec.title,
        shortName: spec.shortName,
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
      mfaRequired: true,
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
      mfaRequired: true,
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
      mfaRequired: true,
    },
    {
      email: 'satinalma@sahilotel.local',
      fullName: 'Sahil Otel - Satın Alma Müdürü',
      role: UserRole.BUSINESS_OWNER,
      companyKey: 'OTEL',
      mfaRequired: true,
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

  process.stdout.write(
    [
      '',
      'Tohum verisi yüklendi.',
      `  Kiracı      : ${tenant.title} (${tenant.code})`,
      `  İşletme     : ${companies.size}`,
      `  Kullanıcı   : ${createdUsers.size}`,
      `  Ortak şifre : ${SEED_PASSWORD}`,
      '',
      '  2FA zorunlu hesaplar ilk girişte TOTP kaydına yönlendirilir.',
      '  Süper Admin yalnızca 127.0.0.1 / ::1 adreslerinden giriş yapabilir.',
      '',
    ].join('\n'),
  );
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
