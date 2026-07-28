/**
 * ToptanPortal API - Bildirim Kuyruga Yazimi
 *
 * KAYIT, IS VERISIYLE AYNI ISLEMDE yazilabilir (`tx` verildiginde). Siparis
 * onaylandi ama bildirim satiri yazilmadiysa, bayi siparisinin onaylandigini
 * ogrenemez ve telefon calar; bildirim yazildi ama siparis yazilmadiysa bayi
 * olmayan bir siparis icin tesekkur alir. Ikisi de ayni isleme baglanarak
 * onlenir.
 *
 * GONDERIM burada YAPILMAZ. Saglayiciya yapilan bir HTTP cagrisi, siparis
 * islemini saglayicinin yanit suresine baglar; yavas bir posta saglayicisi
 * siparis kaydini bekletir ve kilitleri uzatir. Kuyruk bu bagi keser.
 *
 * ALICI SECIMI BIR YETKI KARARIDIR:
 *  * Parasal konu (tahsilat, vade) yalnizca BALANCE_VIEW/STATEMENT_VIEW
 *    yetkisi olan aliciya gider - Kor Siparis Modundaki kullaniciya "vadesi
 *    gecen 8.750,25 TL" yazan bir e-posta gondermek, portalin butun gizleme
 *    cabasini bir mesajla bosa cikarir.
 *  * Siparis konusu ise fiyat gormeyen aliciya da gider; metinden yalnizca
 *    tutar dusulur (bkz. notification-template.ts).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  NotificationChannel,
  NotificationStatus,
  NotificationTopic,
  Permission,
  UserRole,
  canSeeFinancials,
  isTopicMandatory,
  isWithinQuietHours,
  roleHasPermission,
  QUIET_HOURS,
} from '@toptanportal/contracts';
import { UserStatus, type PrismaTransactionClient } from '@toptanportal/db';

import type { AppConfig } from '../config/configuration';
import { PrismaService } from '../common/prisma/prisma.service';
import { DEFAULT_CHANNELS, renderNotification, type NotificationPayload } from './notification-template';

export interface EnqueueInput {
  tenantId: string;
  payload: NotificationPayload;
  /** Alici kullanicilar. Bos gelirse hicbir sey yazilmaz - sessiz gecilir. */
  recipientUserIds: readonly string[];
  /**
   * Olayi tekillestiren anahtar (or. "order:<id>:APPROVED"). Alici ve kanal
   * otomatik eklenir. Geri alinamayan tek islem gonderilmis iletidir; ayni
   * olayin ikinci kez gonderilmesi, portalin kendi kaydina guveni sarsar.
   */
  dedupeKey: string;
  relatedType?: string;
  relatedId?: string;
  /**
   * true ise SESSIZ SAAT kurali uygulanir. Portalin kendi takviminden dogan
   * bildirimler (vade hatirlatmasi) icindir; kullanicinin kendi isleminden
   * dogan bildirim (siparis onayi) beklemez - kullanici o an cevabi bekliyordur.
   */
  scheduled?: boolean;
}

interface AliciKaydi {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly config: AppConfig;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<AppConfig>('app');
  }

  /**
   * Bildirimleri kuyruga yazar ve yazilan satir sayisini dondurur.
   *
   * HICBIR KOSULDA ISTISNA ATMAZ. Bildirim, tetikleyen is akisinin (siparis
   * onayi, tahsilat) yan urunudur; bir sablon hatasi yuzunden onaylanmis bir
   * siparisin geri alinmasi, cozdugunden buyuk bir sorun yaratir. Hata
   * gunluge yazilir ve akis devam eder.
   */
  async enqueue(input: EnqueueInput, tx?: PrismaTransactionClient): Promise<number> {
    try {
      return await this.yaz(input, tx ?? this.prisma);
    } catch (error) {
      this.logger.error(
        `Bildirim kuyruğa yazılamadı (${input.payload.topic} / ${input.dedupeKey}): ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return 0;
    }
  }

  private async yaz(input: EnqueueInput, db: PrismaTransactionClient): Promise<number> {
    if (input.recipientUserIds.length === 0) return 0;

    const topic = input.payload.topic;

    const alicilar = (await db.user.findMany({
      where: {
        id: { in: [...new Set(input.recipientUserIds)] },
        tenantId: input.tenantId,
        deletedAt: null,
      },
      select: { id: true, email: true, fullName: true, role: true, status: true },
    })) as AliciKaydi[];

    const uygunAlicilar = alicilar.filter((alici) => this.aliciUygunMu(alici, topic));
    if (uygunAlicilar.length === 0) return 0;

    const tercihler = await db.notificationPreference.findMany({
      where: { userId: { in: uygunAlicilar.map((alici) => alici.id) }, topic },
      select: { userId: true, channel: true, enabled: true },
    });

    const cihazlar = await db.pushDevice.findMany({
      where: { userId: { in: uygunAlicilar.map((alici) => alici.id) }, revokedAt: null },
      select: { userId: true, tokenHash: true, lastSeenAt: true },
      orderBy: { lastSeenAt: 'desc' },
    });

    const ilkGonderim = this.ilkGonderimZamani(input.scheduled === true);

    const satirlar = uygunAlicilar.flatMap((alici) =>
      DEFAULT_CHANNELS[topic].map((channel) => {
        const tercih = tercihler.find((t) => t.userId === alici.id && t.channel === channel);

        /* Kapatilamayan konularda tercih OKUNMAZ. Kullanicinin gecmiste
           kapattigi bir satir, konu sonradan zorunlu hale geldiginde
           sessizce yururlukte kalmamalidir. */
        const kapali = !isTopicMandatory(topic) && tercih?.enabled === false;

        const cihaz = cihazlar.find((c) => c.userId === alici.id);

        const { subject, body } = renderNotification({
          payload: input.payload,
          channel,
          recipientName: alici.fullName,
          canSeeFinancials: canSeeFinancials(alici.role),
          webBaseUrl: this.config.WEB_BASE_URL,
        });

        /* PUSH icin alici alanina cihaz jetonunun OZETI yazilir. Jetonun
           kendisi, cihaza bildirim gonderebilen bir yetkidir ve gecmis
           kayitlarda acikta durmasi icin bir sebep yoktur; gonderim aninda
           cihaz kaydindan cozulur. */
        const alan = channel === NotificationChannel.EMAIL ? alici.email : (cihaz?.tokenHash ?? '');

        const engel = kapali
          ? 'tercih kapalı'
          : alan.length === 0
            ? channel === NotificationChannel.EMAIL
              ? 'adres yok'
              : 'kayıtlı mobil cihaz yok'
            : null;

        return {
          tenantId: input.tenantId,
          topic,
          channel,
          recipientUserId: alici.id,
          recipient: alan.length > 0 ? alan : '-',
          recipientName: alici.fullName,
          subject,
          body,
          dedupeKey: `${input.dedupeKey}:${alici.id}:${channel}`.slice(0, 160),
          relatedType: input.relatedType ?? null,
          relatedId: input.relatedId ?? null,
          /* Gonderilmeyen kayit da YAZILIR. "Bu bayiye vade hatirlatmasi
             gitti mi?" sorusunun cevabi "hayir, tercihi kapaliydi" olabilir;
             cevapsiz kalmasi olamaz. */
          status: engel === null ? NotificationStatus.PENDING : NotificationStatus.SUPPRESSED,
          suppressedReason: engel,
          nextAttemptAt: ilkGonderim,
        };
      }),
    );

    const { count } = await db.notificationMessage.createMany({
      data: satirlar,
      skipDuplicates: true,
    });

    return count;
  }

  /**
   * Alici bu konuyu ALMALI MI?
   *
   * Askiya alinmis kullaniciya islemsel bildirim gitmez - hesabi kapali olan
   * kisiye siparis durumu bildirmek anlamsizdir. GUVENLIK bildirimi istisnadir
   * ve tam da bu durumda gereklidir: hesabin askiya alindigini ogrenmesi
   * gereken kisi, hesabi askiya alinmis kisidir.
   */
  private aliciUygunMu(alici: AliciKaydi, topic: NotificationTopic): boolean {
    if (topic === NotificationTopic.SECURITY) return true;

    if (alici.status !== UserStatus.ACTIVE) return false;

    /* Parasal konular yetki ister. Kor Siparis Modundaki kullanici bu
       konularin hicbirini ALMAZ; metni tutarsiz uretmek yetmez, cunku
       "vadesi gecen belgeniz var" cumlesi tek basina da ticari bilgidir. */
    if (
      topic === NotificationTopic.PAYMENT_RECEIVED ||
      topic === NotificationTopic.DUE_DATE_REMINDER
    ) {
      return roleHasPermission(alici.role, Permission.BALANCE_VIEW);
    }

    if (topic === NotificationTopic.INTEGRATION_ALERT) {
      return roleHasPermission(alici.role, Permission.INTEGRATION_MANAGE);
    }

    return true;
  }

  /**
   * Zamanlanmis bildirimin gonderilebilecegi ilk an.
   *
   * Sessiz saat disinda uretilen kayit SILINMEZ, ERTELENIR: vade hatirlatmasi
   * gece 02:00'de uretildi diye o gun hic gonderilmemeli degildir.
   */
  private ilkGonderimZamani(scheduled: boolean): Date {
    const simdi = new Date();
    if (!scheduled || isWithinQuietHours(simdi)) return simdi;

    const yerel = new Date(simdi.getTime() + 180 * 60 * 1000);
    const hedef = new Date(yerel);

    if (yerel.getUTCHours() >= QUIET_HOURS.endHour) {
      hedef.setUTCDate(hedef.getUTCDate() + 1);
    }

    hedef.setUTCHours(QUIET_HOURS.startHour, 0, 0, 0);
    return new Date(hedef.getTime() - 180 * 60 * 1000);
  }

  /** Cihaz jetonunun kayitta duran karsiligi. */
  static tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
