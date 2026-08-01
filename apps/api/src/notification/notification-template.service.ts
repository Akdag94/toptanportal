/**
 * ToptanPortal API - Bildirim Sablonu Yonetimi
 *
 * Kiracinin uzerine yazdigi metinleri okur, yazar ve GONDERIM YOLUNA
 * ONBELLEKTEN sunar.
 *
 * ONBELLEK BURADA BIR SUSLEME DEGIL, GEREKLILIKTIR: sablon her bildirim
 * satiri icin okunur ve bir siparis onayi tek seferde alti satir uretebilir.
 * Her satir icin ayri bir sorgu, siparis islemini - kuyruga yazim is
 * verisiyle AYNI islemde oldugu icin - uzatir ve kilitleri bekletir.
 *
 * Onbellek TTL ILE eskir, olay ile degil. Cok ornekli kurulumda baska bir
 * ornekte yapilan degisiklik burada aninda gorunmez; bayatlik suresi
 * `CACHE_TTL_MS` ile SINIRLIDIR ve bu kabul edilebilir bir odundur - metin
 * degisikligi saniyeler icinde yayilmasi gereken bir sey degildir. Kendi
 * ornegimizde yapilan degisiklik ise aninda yansir (yazma sonrasi dusurulur).
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  CHANNEL_LABELS,
  ErrorCode,
  NotificationChannel,
  NotificationTopic,
  TEMPLATE_VARIABLES,
  TOPIC_LABELS,
  unknownPlaceholders,
  type NotificationTemplateList,
  type NotificationTemplatePreviewRequest,
  type NotificationTemplatePreviewResult,
  type NotificationTemplateView,
  type UpsertNotificationTemplateRequest,
} from '@toptanportal/contracts';

import { ApiException } from '../common/exceptions/api.exception';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  DEFAULT_CHANNELS,
  DEFAULT_TEMPLATES,
  applyTemplate,
  type TemplateSource,
} from './notification-template';
import type { AuthenticatedPrincipal } from '../common/context/request-context';

/** Bayatlik ust siniri. Metin degisikligi acil bir yayilim istemez. */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  templates: Map<string, TemplateSource>;
  expiresAt: number;
}

function anahtar(topic: NotificationTopic, channel: NotificationChannel): string {
  return `${topic}:${channel}`;
}

@Injectable()
export class NotificationTemplateService {
  private readonly logger = new Logger(NotificationTemplateService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Gonderim yolu
  // -------------------------------------------------------------------------

  /**
   * Kiracinin sablonlari. Satiri olmayan konu/kanal icin sozlukte KAYIT YOKTUR;
   * cagiran taraf varsayilani kullanir.
   *
   * HICBIR KOSULDA ISTISNA ATMAZ: sablon okunamadi diye onaylanmis bir
   * siparisin bildirimi hic yazilmamalidir. Hata gunluge yazilir ve varsayilan
   * metinler yururlukte kalir.
   */
  async forTenant(tenantId: string): Promise<Map<string, TemplateSource>> {
    const onbellek = this.cache.get(tenantId);
    if (onbellek && onbellek.expiresAt > Date.now()) return onbellek.templates;

    try {
      const satirlar = await this.prisma.notificationTemplate.findMany({
        where: { tenantId },
        select: { topic: true, channel: true, subjectTemplate: true, bodyTemplate: true },
      });

      const templates = new Map<string, TemplateSource>(
        satirlar.map((satir) => [
          anahtar(satir.topic, satir.channel),
          { subject: satir.subjectTemplate, body: satir.bodyTemplate },
        ]),
      );

      this.cache.set(tenantId, { templates, expiresAt: Date.now() + CACHE_TTL_MS });
      return templates;
    } catch (error) {
      this.logger.error(
        `Bildirim şablonları okunamadı (${tenantId}); varsayılan metinler kullanılıyor: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return new Map();
    }
  }

  /** Yazma sonrasi kendi ornegimizde aninda gecerli olmasi icin. */
  private invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  // -------------------------------------------------------------------------
  // Yonetim ekrani
  // -------------------------------------------------------------------------

  async list(principal: AuthenticatedPrincipal): Promise<NotificationTemplateList> {
    const satirlar = await this.prisma.notificationTemplate.findMany({
      where: { tenantId: principal.tenantId },
      include: { updatedBy: { select: { fullName: true } } },
    });

    /* Listelenen satirlar VARSAYILAN KANAL setinden gelir, tum kanallardan
       degil: tahsilat bildiriminin mobil sablonunu duzenlemek, hic
       gonderilmeyecek bir metni duzenlemektir. */
    const templates: NotificationTemplateView[] = Object.values(NotificationTopic).flatMap(
      (topic) =>
        DEFAULT_CHANNELS[topic].map((channel) => {
          const kayit = satirlar.find((s) => s.topic === topic && s.channel === channel);
          const varsayilan = DEFAULT_TEMPLATES[topic];

          return {
            topic,
            topicLabel: TOPIC_LABELS[topic],
            channel,
            channelLabel: CHANNEL_LABELS[channel],
            defaultSubject: varsayilan.subject,
            defaultBody: varsayilan.body,
            subjectTemplate: kayit?.subjectTemplate ?? null,
            bodyTemplate: kayit?.bodyTemplate ?? null,
            customized: kayit !== undefined,
            updatedAt: kayit?.updatedAt.toISOString() ?? null,
            updatedByName: kayit?.updatedBy?.fullName ?? null,
            variables: TEMPLATE_VARIABLES[topic].map((degisken) => ({ ...degisken })),
          };
        }),
    );

    return { templates };
  }

  async upsert(
    principal: AuthenticatedPrincipal,
    body: UpsertNotificationTemplateRequest,
  ): Promise<NotificationTemplateList> {
    this.kanalGecerliMi(body.topic, body.channel);

    await this.prisma.notificationTemplate.upsert({
      where: {
        tenantId_topic_channel: {
          tenantId: principal.tenantId,
          topic: body.topic,
          channel: body.channel,
        },
      },
      create: {
        tenantId: principal.tenantId,
        topic: body.topic,
        channel: body.channel,
        subjectTemplate: body.subjectTemplate,
        bodyTemplate: body.bodyTemplate,
        updatedByUserId: principal.userId,
      },
      update: {
        subjectTemplate: body.subjectTemplate,
        bodyTemplate: body.bodyTemplate,
        updatedByUserId: principal.userId,
      },
    });

    this.invalidate(principal.tenantId);

    /* Denetim kaydina METNIN KENDISI yazilir, "degistirildi" bilgisi degil.
       Hangi cumlenin ne zaman yururlukte oldugu, sonradan cikan bir
       tartismada tek dogrulanabilir kaynaktir. */
    await this.audit.record({
      tenantId: principal.tenantId,
      action: AuditAction.NOTIFICATION_TEMPLATE_CHANGED,
      resourceType: 'NotificationTemplate',
      resourceId: anahtar(body.topic, body.channel),
      payload: {
        topic: body.topic,
        channel: body.channel,
        subjectTemplate: body.subjectTemplate,
        bodyTemplate: body.bodyTemplate,
      },
    });

    return this.list(principal);
  }

  /**
   * Varsayilana dondurur.
   *
   * Satir GUNCELLENMEZ, SILINIR. Varsayilan metni satira kopyalamak, kodda
   * duran metin sonradan iyilestirildiginde bu kiraciyi eski metinde
   * birakirdi - "varsayilana dondum" diyen kullanicinin beklentisi bu degildir.
   */
  async reset(
    principal: AuthenticatedPrincipal,
    topic: NotificationTopic,
    channel: NotificationChannel,
  ): Promise<NotificationTemplateList> {
    const { count } = await this.prisma.notificationTemplate.deleteMany({
      where: { tenantId: principal.tenantId, topic, channel },
    });

    this.invalidate(principal.tenantId);

    if (count > 0) {
      await this.audit.record({
        tenantId: principal.tenantId,
        action: AuditAction.NOTIFICATION_TEMPLATE_RESET,
        resourceType: 'NotificationTemplate',
        resourceId: anahtar(topic, channel),
        payload: { topic, channel },
      });
    }

    return this.list(principal);
  }

  /**
   * Onizleme - KAYDEDILMEMIS metin uzerinde calisir.
   *
   * Iki surum birlikte donulur: yetkili alicinin gordugu ve Kor Siparis
   * Modundaki alicinin gordugu. Ikincisini gormeden sablon yazmak, tutarin
   * sizip sizmadigini gercek bir bildirim gittikten sonra ogrenmektir.
   */
  preview(body: NotificationTemplatePreviewRequest): NotificationTemplatePreviewResult {
    this.kanalGecerliMi(body.topic, body.channel);

    for (const alan of ['subjectTemplate', 'bodyTemplate'] as const) {
      const bilinmeyen = unknownPlaceholders(body.topic, body[alan]);

      if (bilinmeyen.length > 0) {
        throw ApiException.badRequest(
          ErrorCode.VALIDATION_FAILED,
          `Tanınmayan değişken: ${bilinmeyen.map((ad) => `{{${ad}}}`).join(', ')}`,
        );
      }
    }

    const kaynak: TemplateSource = { subject: body.subjectTemplate, body: body.bodyTemplate };

    const ornek = this.exampleVariables(body.topic);
    const parasal = new Set(
      TEMPLATE_VARIABLES[body.topic].filter((d) => d.financial).map((d) => d.key),
    );

    const korOrnek = Object.fromEntries(
      Object.entries(ornek).filter(([ad]) => !parasal.has(ad)),
    );

    const standart = applyTemplate(kaynak, ornek);
    const kor = applyTemplate(kaynak, korOrnek);

    const varsayilan = DEFAULT_TEMPLATES[body.topic];

    return {
      standard: {
        subject: standart.subject ?? applyTemplate(varsayilan, ornek).subject ?? '',
        body: standart.body,
      },
      blind: {
        subject: kor.subject ?? applyTemplate(varsayilan, korOrnek).subject ?? '',
        body: kor.body,
      },
      droppedLineCount: kor.droppedLineCount,
    };
  }

  /** Onizlemede kullanilan ornek degerler - sozlesmede tanimlidir. */
  private exampleVariables(topic: NotificationTopic): Record<string, string> {
    return Object.fromEntries(
      TEMPLATE_VARIABLES[topic].map((degisken) => [degisken.key, degisken.example]),
    );
  }

  /**
   * Konu bu kanaldan gonderiliyor mu?
   *
   * Gonderilmeyen bir kanala sablon yazmak, kullaniciya calismayan bir dugme
   * sunmaktir: metin kaydedilir, kaydedildigi gorunur ve hicbir zaman
   * gonderilmez.
   */
  private kanalGecerliMi(topic: NotificationTopic, channel: NotificationChannel): void {
    if (!DEFAULT_CHANNELS[topic].includes(channel)) {
      throw ApiException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        `"${TOPIC_LABELS[topic]}" bildirimi ${CHANNEL_LABELS[channel]} kanalından gönderilmez; ` +
          'bu kanal için şablon tanımlanamaz.',
      );
    }
  }
}
