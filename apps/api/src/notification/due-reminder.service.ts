/**
 * ToptanPortal API - Vade Hatirlatmasi
 *
 * Toptanciligin en pahali sessiz kaybi, kimsenin aramadigi gecikmis
 * alacaktir. Bu gorev, vadesi yaklasan ve gecen acik belgeler icin gunde bir
 * kez hatirlatma uretir.
 *
 * UC KARAR BU DOSYAYI SEKILLENDIRIR:
 *
 * 1. BELGE BASINA DEGIL, BAYI BASINA hatirlatma uretilir. Dort faturasi
 *    geciken bayiye dort ayri e-posta gondermek, hatirlatmayi spam'e cevirir
 *    ve bir sonrakini okunmadan sildirir.
 *
 * 2. AYNI BELGE ICIN AYNI GUN IKINCI KEZ URETILMEZ (dedupeKey gune baglidir).
 *    Gorev saatte bir calisir; tekillestirme olmadan bayi gunde 24 hatirlatma
 *    alirdi.
 *
 * 3. HATIRLATMA TICARI ILETI DEGILDIR: mevcut bir borc iliskisinin
 *    bildirimidir ve IYS izni gerektirmez. Ayni kanaldan kampanya gondermek
 *    ise bu ayrimi bozar - bu yuzden bu modul kampanya gondermez.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationTopic, Permission, ROLE_PERMISSIONS, UserRole } from '@toptanportal/contracts';
import { UserStatus } from '@toptanportal/db';

import type { AppConfig } from '../config/configuration';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from './notification.service';

/** Bir bayi icin tek turda bildirilecek azami belge. */
const AZAMI_BELGE = 20;

@Injectable()
export class DueReminderService {
  private readonly logger = new Logger(DueReminderService.name);
  private readonly config: AppConfig;

  /** Bakiye gormeye yetkili isletme rolleri - hatirlatma yalnizca onlara gider. */
  private readonly yetkiliRoller = (Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter(
    (role) =>
      role !== UserRole.SUPER_ADMIN &&
      role !== UserRole.SALES_REP &&
      ROLE_PERMISSIONS[role].includes(Permission.BALANCE_VIEW),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<AppConfig>('app');
  }

  /** Bir tur. Uretilen hatirlatma sayisini dondurur. */
  async run(tenantId: string): Promise<number> {
    const bugun = new Date();
    const gunAnahtari = bugun.toISOString().slice(0, 10);

    const sinir = new Date(bugun);
    sinir.setDate(sinir.getDate() + this.config.DUE_REMINDER_LEAD_DAYS);

    const belgeler = await this.prisma.accountEntry.findMany({
      where: {
        tenantId,
        openAmount: { gt: 0 },
        dueDate: { not: null, lte: sinir },
        /* Bloke bayiye otomatik hatirlatma gonderilmez. Blokaj zaten insan
           karariyla konur ve o bayiyle yurutulen bir gorusme vardir; robotun
           araya girmesi, muzakereyi yuruten kisinin elini zayiflatir. */
        company: { isActive: true, isBlocked: false },
      },
      select: {
        id: true,
        companyId: true,
        documentNumber: true,
        dueDate: true,
        openAmount: true,
        currency: true,
      },
      orderBy: { dueDate: 'asc' },
    });

    if (belgeler.length === 0) return 0;

    const bayiBazinda = new Map<string, typeof belgeler>();

    for (const belge of belgeler) {
      const liste = bayiBazinda.get(belge.companyId) ?? [];
      if (liste.length < AZAMI_BELGE) liste.push(belge);
      bayiBazinda.set(belge.companyId, liste);
    }

    let uretilen = 0;

    for (const [companyId, bayiBelgeleri] of bayiBazinda) {
      const alicilar = await this.prisma.user.findMany({
        where: {
          companyId,
          tenantId,
          status: UserStatus.ACTIVE,
          deletedAt: null,
          role: { in: this.yetkiliRoller },
        },
        select: { id: true },
      });

      if (alicilar.length === 0) continue;

      /* Metin EN KRITIK belgeye gore kurulur: en cok geciken belge, gorusmenin
         de konusudur. Digerleri toplamda temsil edilir. */
      const enKritik = bayiBelgeleri[0];
      if (!enKritik?.dueDate) continue;

      const gunFarki = Math.floor(
        (Date.now() - enKritik.dueDate.getTime()) / (24 * 60 * 60 * 1000),
      );

      const toplam = bayiBelgeleri.reduce(
        (acc, belge) => acc + belge.openAmount.toNumber(),
        0,
      );

      const sayi = await this.notifications.enqueue({
        tenantId,
        payload: {
          topic: NotificationTopic.DUE_DATE_REMINDER,
          documentNumber:
            bayiBelgeleri.length > 1
              ? `${enKritik.documentNumber} (+${bayiBelgeleri.length - 1} belge)`
              : enKritik.documentNumber,
          dueDate: enKritik.dueDate.toISOString(),
          amount: toplam,
          currency: enKritik.currency,
          daysOverdue: gunFarki,
        },
        recipientUserIds: alicilar.map((alici) => alici.id),
        /* Gun anahtari tekillestirmeyi gune baglar: gorev saatte bir calisir,
           hatirlatma gunde bir gider. */
        dedupeKey: `due:${companyId}:${gunAnahtari}`,
        relatedType: 'Company',
        relatedId: companyId,
        scheduled: true,
      });

      uretilen += sayi;
    }

    if (uretilen > 0) {
      this.logger.log(`${bayiBazinda.size} bayi için ${uretilen} vade hatırlatması kuyruğa alındı.`);
    }

    return uretilen;
  }
}
