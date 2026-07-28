/**
 * ToptanPortal API - Bildirim Uc Noktalari
 *
 * Iki ayri yetki seviyesi vardir ve ayrimi kasitlidir:
 *
 *  * TERCIHLER ve CIHAZ KAYDI yetki istemez - herkes kendi tercihini yonetir.
 *    Kullanicinin hangi bildirimi alacagini yoneticisinin belirlemesi, hem
 *    gereksiz hem de bir sure sonra herkesin her seyi kapattigi bir talep
 *    kuyrugu uretir.
 *  * GONDERIM KAYDI `NOTIFICATION_LOG_VIEW` ister. O kayit baskalarinin
 *    e-posta adreslerini ve ticari iliskinin ayrintisini tasir; "bu bayiye
 *    vade hatirlatmasi gitti mi" sorusunu cevaplayan kisi ile bildirim alan
 *    kisi ayni kisi degildir.
 */

import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClientPlatform, Prisma, type NotificationTopic as DbTopic } from '@toptanportal/db';
import {
  CHANNEL_LABELS,
  NotificationChannel,
  NotificationStatus,
  NotificationTopic,
  Permission,
  TOPIC_LABELS,
  isTopicMandatory,
  notificationQuerySchema,
  registerPushDeviceSchema,
  updatePreferencesSchema,
  type NotificationPage,
  type NotificationPreferences,
  type NotificationQuery,
  type RegisterPushDeviceRequest,
  type UpdatePreferencesRequest,
} from '@toptanportal/contracts';

import { CurrentUser, RequirePermissions } from '../common/decorators';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from './notification.service';
import { DEFAULT_CHANNELS } from './notification-template';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedPrincipal } from '../common/context/request-context';

@ApiTags('Bildirimler')
@Controller('notifications')
export class NotificationController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('preferences')
  @ApiOperation({ summary: 'Kendi bildirim tercihlerim' })
  async preferences(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<NotificationPreferences> {
    const [kullanici, kayitlar, cihazSayisi] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: principal.userId },
        select: { email: true },
      }),
      this.prisma.notificationPreference.findMany({
        where: { userId: principal.userId },
        select: { topic: true, channel: true, enabled: true },
      }),
      this.prisma.pushDevice.count({ where: { userId: principal.userId, revokedAt: null } }),
    ]);

    const preferences = Object.values(NotificationTopic).flatMap((topic) =>
      /* Tum kanallar degil, konunun VARSAYILAN kanallari listelenir. Tahsilat
         bildiriminin mobil satirini gostermek, kullaniciya calismayan bir
         dugme sunmak olurdu. */
      DEFAULT_CHANNELS[topic].map((channel) => {
        const kayit = kayitlar.find((k) => k.topic === topic && k.channel === channel);

        return {
          topic,
          channel,
          enabled: isTopicMandatory(topic) ? true : (kayit?.enabled ?? true),
          locked: isTopicMandatory(topic),
        };
      }),
    );

    return {
      preferences,
      email: kullanici.email,
      hasPushDevice: cihazSayisi > 0,
    };
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Bildirim tercihlerini güncelle' })
  async updatePreferences(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(updatePreferencesSchema)) body: UpdatePreferencesRequest,
  ): Promise<NotificationPreferences> {
    /* Kapatilamayan konular sessizce ATILIR, hata dondurulmez: istemci eski
       bir surumse veya konu sonradan zorunlu hale geldiyse, kullanicinin
       ekrani hata mesajiyla karsilamasi gerekmez - satir zaten kilitli
       gosterilir. */
    const uygulanabilir = body.updates.filter((guncelleme) => !isTopicMandatory(guncelleme.topic));

    await this.prisma.$transaction(
      uygulanabilir.map((guncelleme) =>
        this.prisma.notificationPreference.upsert({
          where: {
            userId_topic_channel: {
              userId: principal.userId,
              topic: guncelleme.topic,
              channel: guncelleme.channel,
            },
          },
          create: {
            userId: principal.userId,
            topic: guncelleme.topic,
            channel: guncelleme.channel,
            enabled: guncelleme.enabled,
          },
          update: { enabled: guncelleme.enabled },
        }),
      ),
    );

    return this.preferences(principal);
  }

  @Post('devices')
  @ApiOperation({ summary: 'Mobil bildirim cihazı kaydı' })
  async registerDevice(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(registerPushDeviceSchema)) body: RegisterPushDeviceRequest,
  ): Promise<{ registered: boolean }> {
    const tokenHash = NotificationService.tokenHash(body.token);

    /* Ayni jeton baska bir kullaniciya gecebilir: ortak tablet, personel
       degisikligi. Jeton benzersizdir ve kayit YENI sahibine gecer; aksi
       halde isten ayrilan baristanin telefonuna sonraki siparisler dusmeye
       devam ederdi. */
    await this.prisma.pushDevice.upsert({
      where: { token: body.token },
      create: {
        userId: principal.userId,
        platform: body.platform as ClientPlatform,
        token: body.token,
        tokenHash,
        deviceName: body.deviceName ?? null,
      },
      update: {
        userId: principal.userId,
        platform: body.platform as ClientPlatform,
        tokenHash,
        deviceName: body.deviceName ?? null,
        lastSeenAt: new Date(),
        revokedAt: null,
      },
    });

    return { registered: true };
  }

  @Delete('devices/:token')
  @ApiOperation({ summary: 'Mobil cihaz kaydını kaldır' })
  async revokeDevice(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('token') token: string,
  ): Promise<{ revoked: boolean }> {
    /* Kayit SILINMEZ, iptal edilir. Silinen bir cihaz, "bu bildirim neden
       gitmedi" sorusunu cevapsiz birakir. */
    const { count } = await this.prisma.pushDevice.updateMany({
      where: { userId: principal.userId, tokenHash: NotificationService.tokenHash(token) },
      data: { revokedAt: new Date() },
    });

    return { revoked: count > 0 };
  }

  @Get()
  @RequirePermissions(Permission.NOTIFICATION_LOG_VIEW)
  @ApiOperation({ summary: 'Bildirim gönderim kaydı' })
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(notificationQuerySchema)) query: NotificationQuery,
  ): Promise<NotificationPage> {
    const where: Prisma.NotificationMessageWhereInput = {
      tenantId: principal.tenantId,
      ...(query.topic ? { topic: query.topic as DbTopic } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.recipientUserId ? { recipientUserId: query.recipientUserId } : {}),
      ...(query.q
        ? {
            OR: [
              { recipient: { contains: query.q, mode: 'insensitive' } },
              { recipientName: { contains: query.q, mode: 'insensitive' } },
              { subject: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [kayitlar, toplam, bekleyen, basarisiz] = await Promise.all([
      this.prisma.notificationMessage.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.notificationMessage.count({ where }),
      /* Ust seritteki iki sayi SUZGECTEN BAGIMSIZDIR: ekranda bir konuyu
         suzerken kuyrukta bekleyen mesajlarin gorunmez olmasi, sorunu
         suzgecin arkasina saklar. */
      this.prisma.notificationMessage.count({
        where: { tenantId: principal.tenantId, status: NotificationStatus.PENDING },
      }),
      this.prisma.notificationMessage.count({
        where: { tenantId: principal.tenantId, status: NotificationStatus.FAILED },
      }),
    ]);

    return {
      messages: kayitlar.map((kayit) => ({
        id: kayit.id.toString(),
        topic: kayit.topic,
        channel: kayit.channel,
        status: kayit.status,
        /* PUSH kaydinda alici alani cihaz jetonunun ozetidir; ekranda ham
           ozet gostermek bilgi degil gurultudur. */
        recipient:
          kayit.channel === NotificationChannel.PUSH
            ? `${CHANNEL_LABELS[NotificationChannel.PUSH]} · ${kayit.recipient.slice(0, 8)}`
            : kayit.recipient,
        recipientUserId: kayit.recipientUserId,
        recipientName: kayit.recipientName,
        subject: kayit.subject,
        attempts: kayit.attempts,
        lastError: kayit.lastError,
        suppressedReason: kayit.suppressedReason,
        createdAt: kayit.createdAt.toISOString(),
        sentAt: kayit.sentAt?.toISOString() ?? null,
      })),
      totalCount: toplam,
      hasMore: query.offset + kayitlar.length < toplam,
      pendingCount: bekleyen,
      failedCount: basarisiz,
    };
  }

  /** Ekranin suzgec listeleri icin etiketler. */
  @Get('labels')
  @ApiOperation({ summary: 'Konu ve kanal etiketleri' })
  labels(): { topics: Record<string, string>; channels: Record<string, string> } {
    return { topics: TOPIC_LABELS, channels: CHANNEL_LABELS };
  }
}
