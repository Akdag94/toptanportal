/**
 * ToptanPortal API - e-Belge Gonderimi ve GIB Durum Takibi
 *
 * KESME ILE GONDERME AYRIDIR. Belge kesildiginde arsive yazilir ve DRAFT
 * durumunda kalir; entegratore iletim bakim gorevinden yapilir. Sebep,
 * bildirim kuyrugundakiyle aynidir: kullanicinin "fatura kes" istegini
 * entegratorun yanit suresine baglamak, yavas bir saglayicida istek zaman
 * asimina ugratir ve kullanici belgenin kesilip kesilmedigini bilemez -
 * oysa belge kesilmistir, arsivdedir ve numarasi tuketilmistir.
 *
 * GONDERIM IDEMPOTENTTIR. Zaman asiminda "gonderdim mi?" sorusunun cevabi
 * yoktur; tekrar denemek zorunludur ve guvenli olmasi entegratorun ayni ETTN
 * icin yeni belge uretmemesine baglidir (bkz. einvoice-provider.ts).
 *
 * DURUM TAKIBI SORARAK YAPILIR, BILDIRIM BEKLENEREK DEGIL. Entegratorun geri
 * bildirimi kaybolabilir; "faturam alicinin sistemine ulasti mi" sorusunun
 * cevabini portalin kendi kaydindan verebilmesi gerekir. Bu yuzden acik
 * belgeler duzenli olarak sorgulanir.
 *
 * TERMINAL DURUMLAR SORULMAZ. Kabul, ret, hata ve iptal son duraktir; bunlari
 * tekrar sormak, entegratore her turda buyuyen ve hicbir sey ogretmeyen bir
 * yuk bindirir.
 */

import { Injectable, Logger } from '@nestjs/common';
import { EDocumentStatus as DbStatus } from '@toptanportal/db';
import { AuditAction, EDocumentStatus } from '@toptanportal/contracts';

import { AuditService } from '../common/audit/audit.service';
import { DocumentStorageService } from './document-storage.service';
import { EInvoiceProvider, ProviderPermanentError } from './einvoice-provider';
import { PrismaService } from '../common/prisma/prisma.service';

/** Tek turda gonderilecek azami belge. Tur suresini ongorulebilir tutar. */
const SEND_BATCH_SIZE = 20;
/** Tek turda durumu sorulacak azami belge. */
const STATUS_BATCH_SIZE = 50;

/** Durumu artik degismeyecek belgeler - sorgulanmazlar. */
const TERMINAL_STATUSES = [
  DbStatus.ACCEPTED,
  DbStatus.REJECTED,
  DbStatus.FAILED,
  DbStatus.CANCELLED,
] as const;

export interface DispatchOutcome {
  sent: number;
  failed: number;
  retried: number;
}

export interface StatusOutcome {
  checked: number;
  changed: number;
}

@Injectable()
export class EDocumentDispatchService {
  private readonly logger = new Logger(EDocumentDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: EInvoiceProvider,
    private readonly storage: DocumentStorageService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Bekleyen belgeleri entegratore iletir.
   *
   * GECICI HATADA BELGE DRAFT KALIR ve bir sonraki turda tekrar denenir;
   * deneme hakki TUKENMEZ. Bildirimden farkli olarak burada vazgecmek dogru
   * degildir: kesilmis bir fatura gonderilmezse musteri onu hic gormez ama
   * defterde durur - "denemekten vazgectik" diyebilecegimiz bir belge yoktur.
   * Hata metni kayitta durur ve ekranda gorunur.
   */
  async dispatchBatch(): Promise<DispatchOutcome> {
    if (!this.provider.configured) return { sent: 0, failed: 0, retried: 0 };

    const bekleyenler = await this.prisma.eDocument.findMany({
      where: { status: DbStatus.DRAFT },
      include: { company: { select: { taxNumber: true } } },
      orderBy: { createdAt: 'asc' },
      take: SEND_BATCH_SIZE,
    });

    let gonderilen = 0;
    let basarisiz = 0;
    let tekrar = 0;

    for (const belge of bekleyenler) {
      const dosya = await this.storage.open(belge.xmlPath);

      if (dosya === null) {
        /* Kayit var, dosya yok. Bu bir ARSIV TUTARSIZLIGIDIR ve gonderimle
           cozulmez; belge hatali isaretlenir ve insana duser. */
        await this.markFailed(belge.id, 'Belgenin XML dosyası arşivde bulunamadı.');
        basarisiz += 1;
        continue;
      }

      const xml = await metinOku(dosya.stream);

      /* Dosyanin ozeti kayitla TUTMALIDIR. Tutmuyorsa arsivdeki dosya
         degismistir; degismis bir belgeyi imzalatmak, portalin kendi
         kaydindan farkli bir faturayi hukuki asil yapmaktir. */
      const ozet = await this.storage.computeHash(belge.xmlPath);

      if (ozet !== belge.contentHash) {
        await this.markFailed(
          belge.id,
          'Arşivdeki belge, kayıttaki özetle uyuşmuyor; gönderilmedi.',
        );
        this.logger.error(
          `Arşiv bütünlüğü ihlali: ${belge.documentNumber} (${belge.id}) dosyası değişmiş.`,
        );
        basarisiz += 1;
        continue;
      }

      try {
        const sonuc = await this.provider.send({
          uuid: belge.uuid,
          documentNumber: belge.documentNumber,
          kind: belge.kind,
          customerTaxNumber: belge.company.taxNumber ?? '',
          xml,
        });

        await this.prisma.eDocument.update({
          where: { id: belge.id },
          data: {
            status: sonuc.status as DbStatus,
            providerRef: sonuc.providerRef,
            sentAt: new Date(),
            errorMessage: null,
          },
        });

        await this.audit.recordSafely({
          tenantId: belge.tenantId,
          action: AuditAction.EDOCUMENT_SENT,
          resourceType: 'EDocument',
          resourceId: belge.id,
          companyId: belge.companyId,
          payload: { documentNumber: belge.documentNumber, providerRef: sonuc.providerRef },
        });

        gonderilen += 1;
      } catch (error) {
        const mesaj = error instanceof Error ? error.message : String(error);

        if (error instanceof ProviderPermanentError) {
          await this.markFailed(belge.id, mesaj);
          basarisiz += 1;
          continue;
        }

        /* Gecici hata: belge DRAFT kalir. Hata metni yazilir ki "neden hala
           gonderilmedi" sorusu ekrandan cevaplanabilsin. */
        await this.prisma.eDocument.update({
          where: { id: belge.id },
          data: { errorMessage: mesaj.slice(0, 500) },
        });

        tekrar += 1;
      }
    }

    return { sent: gonderilen, failed: basarisiz, retried: tekrar };
  }

  /**
   * Acik belgelerin GIB durumunu sorar.
   *
   * `DELIVERED` ile `ACCEPTED` arasindaki fark burada korunur: e-Fatura'da
   * alicinin reddetme hakki vardir ve reddedilmis bir faturayi tahsil
   * edilebilir gostermek, tahsilat gorusmesini bastan kaybettirir.
   */
  async trackStatuses(): Promise<StatusOutcome> {
    if (!this.provider.configured) return { checked: 0, changed: 0 };

    const acikBelgeler = await this.prisma.eDocument.findMany({
      where: {
        status: { notIn: [...TERMINAL_STATUSES, DbStatus.DRAFT] },
        providerRef: { not: null },
      },
      orderBy: { sentAt: 'asc' },
      take: STATUS_BATCH_SIZE,
    });

    let degisen = 0;

    for (const belge of acikBelgeler) {
      try {
        const sonuc = await this.provider.queryStatus(belge.uuid);

        // null: taninmayan kod veya durum yok. Belge OLDUGU YERDE kalir.
        if (sonuc === null || sonuc.status === belge.status) continue;

        await this.prisma.eDocument.update({
          where: { id: belge.id },
          data: {
            status: sonuc.status as DbStatus,
            responseNote: sonuc.note?.slice(0, 500) ?? belge.responseNote,
            respondedAt:
              sonuc.status === EDocumentStatus.ACCEPTED || sonuc.status === EDocumentStatus.REJECTED
                ? (sonuc.respondedAt ?? new Date())
                : belge.respondedAt,
            errorMessage: sonuc.status === EDocumentStatus.FAILED ? sonuc.note : null,
          },
        });

        await this.audit.recordSafely({
          tenantId: belge.tenantId,
          action: AuditAction.EDOCUMENT_STATUS_CHANGED,
          resourceType: 'EDocument',
          resourceId: belge.id,
          companyId: belge.companyId,
          payload: {
            documentNumber: belge.documentNumber,
            from: belge.status,
            to: sonuc.status,
            note: sonuc.note,
          },
        });

        if (sonuc.status === EDocumentStatus.REJECTED) {
          /* Ret, ticari sonucu olan bir olaydir: fatura hukuken gecersiz
             sayilir ve yeniden kesilmesi gerekir. Sessiz gecilmez. */
          this.logger.warn(
            `Fatura reddedildi: ${belge.documentNumber} — ${sonuc.note ?? 'gerekçe belirtilmedi'}`,
          );
        }

        degisen += 1;
      } catch (error) {
        /* Durum sorgusundaki hata belgeyi DEGISTIRMEZ. Sorgu basarisiz diye
           belgeyi hatali isaretlemek, ulasmis bir faturayi hatali gostermek
           olurdu. */
        this.logger.warn(
          `${belge.documentNumber} durumu sorgulanamadı: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    return { checked: acikBelgeler.length, changed: degisen };
  }

  private async markFailed(documentId: string, message: string): Promise<void> {
    await this.prisma.eDocument.update({
      where: { id: documentId },
      data: { status: DbStatus.FAILED, errorMessage: message.slice(0, 500) },
    });
  }
}

async function metinOku(stream: NodeJS.ReadableStream): Promise<string> {
  const parcalar: Buffer[] = [];

  for await (const parca of stream) {
    parcalar.push(typeof parca === 'string' ? Buffer.from(parca, 'utf8') : parca);
  }

  return Buffer.concat(parcalar).toString('utf8');
}
