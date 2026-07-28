/**
 * ToptanPortal API - Bildirim Gonderimi
 *
 * Kuyruktan is ceker ve tasima katmanina verir. Cekme `FOR UPDATE SKIP LOCKED`
 * ile yapilir: bakim gorevleri lider kilidi altinda calissa da, coklu ornekli
 * bir kurulumda ayni mesajin iki kez gonderilmesi ihtimali burada da
 * kapatilmalidir - gonderilmis bir e-posta geri alinamaz ve "iki kez ayni
 * hatirlatma" kaydin kendisine olan guveni sarsar.
 *
 * BASARISIZLIK BURADA SESSIZ DEGILDIR. Deneme hakki tukenen mesaj FAILED
 * olarak durur ve ekranda gorunur; silinmez. Gonderilemeyen bir vade
 * hatirlatmasi, tahsilat gorusmesinde "size yazmistik" diyememek demektir ve
 * bunu gorusmeden ONCE bilmek gerekir.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { NotificationChannel, NotificationStatus } from '@toptanportal/contracts';

import type { AppConfig } from '../config/configuration';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  MailTransport,
  PushTransport,
  TransportPermanentError,
  type NotificationTransport,
  type OutboundMessage,
} from './notification-transport';

/** Tek turda gonderilecek azami mesaj. */
const PARTI_BOYU = 25;

@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);
  private readonly workerId = `api-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly config: AppConfig;
  private readonly transports: Map<NotificationChannel, NotificationTransport>;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    mail: MailTransport,
    push: PushTransport,
  ) {
    this.config = configService.getOrThrow<AppConfig>('app');
    this.transports = new Map([
      [NotificationChannel.EMAIL, mail as NotificationTransport],
      [NotificationChannel.PUSH, push as NotificationTransport],
    ]);
  }

  /** Bir tur. Gonderilen mesaj sayisini dondurur. */
  async dispatchBatch(): Promise<{ sent: number; failed: number; suppressed: number }> {
    const claimed = await this.prisma.$queryRaw<{ id: bigint }[]>`
      UPDATE notification_messages
      SET "lockedBy" = ${this.workerId},
          "lockedAt" = NOW(),
          attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM notification_messages
        WHERE status = 'PENDING'
          AND "nextAttemptAt" <= NOW()
        ORDER BY id
        LIMIT ${PARTI_BOYU}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;

    let sent = 0;
    let failed = 0;
    let suppressed = 0;

    for (const { id } of claimed) {
      const sonuc = await this.gonder(id);
      if (sonuc === 'sent') sent += 1;
      else if (sonuc === 'failed') failed += 1;
      else if (sonuc === 'suppressed') suppressed += 1;
    }

    return { sent, failed, suppressed };
  }

  private async gonder(id: bigint): Promise<'sent' | 'failed' | 'suppressed' | 'retry'> {
    const mesaj = await this.prisma.notificationMessage.findUnique({ where: { id } });
    if (!mesaj) return 'retry';

    const transport = this.transports.get(mesaj.channel as NotificationChannel);

    if (!transport || !transport.configured) {
      /* Kanal yapilandirilmamis. Bu bir HATA DEGIL, bir kurulum halidir:
         mesaji alti kez deneyip FAILED yapmak, ekrani gercek hatalarin
         gorunmedigi bir listeye cevirir. */
      return this.bastir(id, `${mesaj.channel} kanalı yapılandırılmadı`);
    }

    const hedef = await this.hedefAdres(mesaj.channel as NotificationChannel, mesaj.recipient);

    if (hedef === null) {
      return this.bastir(id, 'kayıtlı mobil cihaz kalmadı');
    }

    const gonderilecek: OutboundMessage = {
      recipient: hedef,
      recipientName: mesaj.recipientName,
      subject: mesaj.subject,
      body: mesaj.body,
    };

    try {
      await transport.send(gonderilecek);

      await this.prisma.notificationMessage.update({
        where: { id },
        data: {
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          lockedBy: null,
          lockedAt: null,
          lastError: null,
        },
      });

      return 'sent';
    } catch (error) {
      const mesajMetni = error instanceof Error ? error.message : String(error);
      const kalici = error instanceof TransportPermanentError;

      /* Kalici hata deneme hakkini TUKETMEDEN basarisiz sayilir: gecersiz bir
         adresi alti kez denemek, saglayici nezdinde gonderen itibarini
         dusurur ve gecerli adreslere giden mesajlari da istenmeyen klasorune
         iter. */
      const tukendi = kalici || mesaj.attempts >= mesaj.maxAttempts;

      await this.prisma.notificationMessage.update({
        where: { id },
        data: {
          status: tukendi ? NotificationStatus.FAILED : NotificationStatus.PENDING,
          nextAttemptAt: new Date(Date.now() + this.geriCekilmeSaniye(mesaj.attempts) * 1000),
          lastError: mesajMetni.slice(0, 1000),
          lockedBy: null,
          lockedAt: null,
        },
      });

      if (tukendi) {
        this.logger.error(`Bildirim gönderilemedi (#${id}): ${mesajMetni}`);
        return 'failed';
      }

      return 'retry';
    }
  }

  /**
   * PUSH kaydinda alici alani cihaz jetonunun OZETIDIR; gercek jeton gonderim
   * aninda cozulur. Cihaz o arada iptal edildiyse (kullanici cikis yapti,
   * telefon degisti) mesaj bastirilir - iptal edilmis bir cihaza gonderim
   * denemek, isten ayrilan personelin telefonuna siparis dusurmektir.
   */
  private async hedefAdres(channel: NotificationChannel, recipient: string): Promise<string | null> {
    if (channel === NotificationChannel.EMAIL) return recipient;

    const cihaz = await this.prisma.pushDevice.findFirst({
      where: { tokenHash: recipient, revokedAt: null },
      select: { token: true },
    });

    return cihaz?.token ?? null;
  }

  private async bastir(id: bigint, sebep: string): Promise<'suppressed'> {
    await this.prisma.notificationMessage.update({
      where: { id },
      data: {
        status: NotificationStatus.SUPPRESSED,
        suppressedReason: sebep,
        lockedBy: null,
        lockedAt: null,
      },
    });

    return 'suppressed';
  }

  /** Ustel geri cekilme; ust sinir bir saat. */
  private geriCekilmeSaniye(attempts: number): number {
    return Math.min(2 ** Math.max(attempts, 1) * 60, 3600);
  }

  /**
   * Saklama suresi dolan kayitlari siler.
   *
   * Bildirim yasal saklama yukumlulugu olan bir belge degildir; alici
   * adresini ve ticari iliskinin ayrintisini tasiyan kisisel veridir ve KVKK
   * gereginden uzun saklamayi yasaklar. Gonderildigi GERCEGI denetim
   * kaydinda ayrica durur - silinen sey metindir, olay degil.
   */
  async purgeExpired(): Promise<number> {
    const sinir = new Date(
      Date.now() - this.config.NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    const { count } = await this.prisma.notificationMessage.deleteMany({
      where: {
        createdAt: { lt: sinir },
        status: { in: [NotificationStatus.SENT, NotificationStatus.SUPPRESSED] },
      },
    });

    return count;
  }
}
