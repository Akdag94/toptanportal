/**
 * ToptanPortal API - Sanal POS Akisi
 *
 * Iki adim vardir ve aralarinda KULLANICI ile BANKA durur:
 *
 *   1. `start`  - islem kaydi acilir, banka formu uretilir. Henuz para yok.
 *   2. `handleCallback` - banka sonucu geri gonderir; dogrulanir, tahsilat
 *      kapatilir.
 *
 * Ikinci adimda oturum YOKTUR: istek bankanin tarayici yonlendirmesiyle gelir,
 * jeton tasimaz. Guvenligi saglayan sey oturum degil, magaza anahtariyla
 * hesaplanan OZETTIR. Bu yuzden ozeti dogrulanamayan bir yanit hicbir sey
 * degistirmez - kayda dokunulmaz, yalnizca denetim kaydi yazilir.
 *
 * TUTAR HER ZAMAN VERITABANINDAN OKUNUR. Bankadan donen tutar, kullanicinin
 * tarayicisindan gecmistir.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  PaymentMethod as PaymentMethodEnum,
  PaymentStatus as PaymentStatusEnum,
  PosTransactionStatus as PosStatusEnum,
  Prisma,
} from '@toptanportal/db';
import {
  AuditAction,
  ErrorCode,
  POS_TRANSACTION_STATUS_LABELS,
  type CardPaymentForm,
  type PosTransactionView,
  type StartCardPaymentRequest,
} from '@toptanportal/contracts';

import type { AppConfig } from '../config/configuration';
import { AuditService } from '../common/audit/audit.service';
import { ApiException } from '../common/exceptions/api.exception';
import { CompanyScopeService } from '../common/context/company-scope.service';
import { PaymentService, PAYMENT_INCLUDE } from '../finance/payment.service';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { NestPayProvider, type PosProvider } from './pos-provider';

/** Banka sayfasinda gecirilebilecek azami sure. */
const FORM_GECERLILIK_SANIYE = 900;

@Injectable()
export class PosService {
  private readonly logger = new Logger(PosService.name);
  private readonly config: AppConfig;
  private readonly provider: PosProvider | null;

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly scope: CompanyScopeService,
    private readonly payments: PaymentService,
    private readonly audit: AuditService,
  ) {
    this.config = configService.getOrThrow<AppConfig>('app');
    this.provider = this.createProvider();
  }

  get isEnabled(): boolean {
    return this.provider !== null;
  }

  private createProvider(): PosProvider | null {
    const { POS_PROVIDER, POS_MERCHANT_ID, POS_TERMINAL_ID, POS_STORE_KEY } = this.config;
    const { POS_GATEWAY_URL, POS_CALLBACK_URL } = this.config;

    if (
      POS_PROVIDER === undefined ||
      POS_MERCHANT_ID === undefined ||
      POS_STORE_KEY === undefined ||
      POS_GATEWAY_URL === undefined ||
      POS_CALLBACK_URL === undefined
    ) {
      return null;
    }

    return new NestPayProvider({
      merchantId: POS_MERCHANT_ID,
      terminalId: POS_TERMINAL_ID ?? '',
      storeKey: POS_STORE_KEY,
      gatewayUrl: POS_GATEWAY_URL,
      callbackUrl: POS_CALLBACK_URL,
    });
  }

  // -------------------------------------------------------------------------
  // 1. Adim - islemi baslat
  // -------------------------------------------------------------------------

  async start(
    principal: AuthenticatedPrincipal,
    request: StartCardPaymentRequest,
  ): Promise<CardPaymentForm> {
    if (this.provider === null) {
      throw ApiException.serviceUnavailable(ErrorCode.POS_NOT_CONFIGURED);
    }

    if (request.installment > this.config.POS_MAX_INSTALLMENT) {
      throw ApiException.unprocessable(
        ErrorCode.VALIDATION_FAILED,
        `En fazla ${this.config.POS_MAX_INSTALLMENT} taksit yapılabilir.`,
      );
    }

    const companyId = await this.scope.resolve(principal, request.companyId);
    const amount = new Prisma.Decimal(request.amount).toDecimalPlaces(2);

    /* Siparis kimligi bankaya gonderilen ve geri donen tek baglantidir.
       Tahmin edilebilir olmamalidir: ardisik bir numara, baskasinin islemini
       geri donusle etkilemeyi denemenin kapisini aralar. */
    const merchantOrderId = `TP${Date.now().toString(36).toUpperCase()}${randomUUID().slice(0, 8).toUpperCase()}`;

    const transaction = await this.prisma.posTransaction.create({
      data: {
        tenantId: principal.tenantId,
        companyId,
        initiatedByUserId: principal.userId,
        amount,
        installment: request.installment,
        merchantOrderId,
        requestedAllocations: (request.allocations ?? []) as unknown as Prisma.InputJsonValue,
      },
    });

    await this.audit.recordSafely({
      tenantId: principal.tenantId,
      action: AuditAction.PAYMENT_INITIATED,
      resourceType: 'PosTransaction',
      resourceId: transaction.id,
      companyId,
      payload: {
        amount: amount.toString(),
        installment: request.installment,
        merchantOrderId,
      },
    });

    const form = this.provider.buildForm({
      merchantOrderId,
      amount: amount.toFixed(2),
      /* 949 = TRY (ISO 4217 sayisal). Bankalar alfabetik kodu kabul etmez. */
      currencyCode: '949',
      installment: request.installment,
      returnUrl: `${this.config.WEB_BASE_URL}/panel/odeme`,
    });

    return {
      transactionId: transaction.id,
      actionUrl: form.actionUrl,
      method: 'POST',
      fields: form.fields,
      expiresIn: FORM_GECERLILIK_SANIYE,
    };
  }

  // -------------------------------------------------------------------------
  // 2. Adim - bankadan donus
  // -------------------------------------------------------------------------

  /**
   * Banka yanitini isler ve kullanicinin yonlendirilecegi portal adresini doner.
   *
   * ASLA ISTISNA FIRLATMAZ: bu uca banka gelir, kullanici degil. Hata sayfasi
   * gormesi gereken taraf kullanicidir ve o da yonlendirme sonunda portali
   * gorur. Burada 500 donmek, bankanin islemi "belirsiz" isaretlemesine ve
   * mutabakatta ek is cikmasina yol acar.
   */
  async handleCallback(tenantCode: string, payload: Record<string, string>): Promise<string> {
    const taban = `${this.config.WEB_BASE_URL}/panel/odeme`;

    if (this.provider === null) {
      return `${taban}?sonuc=hata&sebep=pos-kapali`;
    }

    if (!this.provider.verify(payload)) {
      /* Ozeti tutmayan yanit, bankadan gelmemis olabilir. Hicbir kayda
         dokunulmaz; yalnizca iz birakilir. Sessizce yutmak, bir saldiri
         denemesini gorunmez kilardi. */
      this.logger.error('Özeti doğrulanamayan POS yanıtı reddedildi.');

      const kiraciId = await this.resolveTenantId(tenantCode);

      /* Kiraci cozulemiyorsa denetim kaydi da yazilamaz - zincir kiraci
         basinadir. Gunluk kaydi yukarida zaten dusuldu. */
      if (kiraciId !== null) {
        await this.audit.recordSafely({
          tenantId: kiraciId,
          action: AuditAction.PAYMENT_FAILED,
          outcome: 'DENIED',
          resourceType: 'PosTransaction',
          payload: { reason: 'HASH_MISMATCH', merchantOrderId: payload.oid ?? null },
        });
      }

      return `${taban}?sonuc=hata&sebep=dogrulama`;
    }

    const sonuc = this.provider.parseCallback(payload);
    const tenantId = await this.resolveTenantId(tenantCode);

    if (tenantId === null) {
      return `${taban}?sonuc=hata&sebep=kiraci`;
    }

    const transaction = await this.prisma.posTransaction.findUnique({
      where: {
        tenantId_merchantOrderId: { tenantId, merchantOrderId: sonuc.merchantOrderId },
      },
    });

    if (!transaction) {
      this.logger.error(`Bilinmeyen POS işlemi: ${sonuc.merchantOrderId}`);
      return `${taban}?sonuc=hata&sebep=islem-bulunamadi`;
    }

    /* Banka aynı sonucu iki kez gonderebilir (kullanici geri tusu, ag tekrari).
       Tamamlanmis islem tekrar islenmez - ikinci kez tahsilat kapatmak,
       bayinin borcunu odemedigi halde silmektir. */
    if (transaction.status !== PosStatusEnum.INITIATED) {
      return `${taban}?sonuc=${transaction.status === PosStatusEnum.SUCCEEDED ? 'basarili' : 'hata'}&islem=${transaction.id}`;
    }

    if (!sonuc.approved) {
      await this.prisma.posTransaction.update({
        where: { id: transaction.id },
        data: {
          status: PosStatusEnum.FAILED,
          providerRef: sonuc.providerRef,
          providerCode: sonuc.providerCode,
          maskedPan: sonuc.maskedPan,
          cardBrand: sonuc.cardBrand,
          errorCode: sonuc.errorCode,
          errorMessage: sonuc.errorMessage?.slice(0, 500) ?? null,
          completedAt: new Date(),
        },
      });

      await this.audit.recordSafely({
        tenantId,
        action: AuditAction.PAYMENT_FAILED,
        outcome: 'FAILURE',
        resourceType: 'PosTransaction',
        resourceId: transaction.id,
        companyId: transaction.companyId,
        payload: {
          amount: transaction.amount.toString(),
          providerCode: sonuc.providerCode,
          errorCode: sonuc.errorCode,
        },
      });

      return `${taban}?sonuc=hata&islem=${transaction.id}`;
    }

    try {
      await this.settleApproved(transaction.id, sonuc);
      return `${taban}?sonuc=basarili&islem=${transaction.id}`;
    } catch (error) {
      /* PARA CEKILDI AMA PORTAL YAZAMADI. En tehlikeli durum budur ve
         basarisiz sayilmaz: islem INSAN INCELEMESINE dusurulur, banka
         referansi kaydedilir. Musteriye "ödeme başarısız" demek, parasi
         cekilmisken yeniden odemeye yonlendirmek olurdu. */
      const mesaj = error instanceof Error ? error.message : 'bilinmeyen hata';

      await this.prisma.posTransaction.update({
        where: { id: transaction.id },
        data: {
          status: PosStatusEnum.NEEDS_REVIEW,
          providerRef: sonuc.providerRef,
          providerCode: sonuc.providerCode,
          authCode: sonuc.authCode,
          maskedPan: sonuc.maskedPan,
          errorMessage: `Banka onayladı, portal işleyemedi: ${mesaj}`.slice(0, 500),
          completedAt: new Date(),
        },
      });

      this.logger.error(
        `POS ${transaction.merchantOrderId}: banka onayladı, tahsilat yazılamadı - ${mesaj}`,
      );

      await this.audit.recordSafely({
        tenantId,
        action: AuditAction.PAYMENT_FAILED,
        outcome: 'FAILURE',
        resourceType: 'PosTransaction',
        resourceId: transaction.id,
        companyId: transaction.companyId,
        payload: {
          needsReview: true,
          providerRef: sonuc.providerRef,
          amount: transaction.amount.toString(),
        },
      });

      return `${taban}?sonuc=inceleme&islem=${transaction.id}`;
    }
  }

  /**
   * Onaylanan islemin tahsilatini tek islemde yazar.
   *
   * Tahsilat kaydi ve islem guncellemesi AYNI islemdedir: biri yazilip digeri
   * yazilmazsa, ya odenmis bir tahsilat kaybolur ya da hicbir odeme olmadan
   * borc kapanir.
   */
  private async settleApproved(
    transactionId: string,
    sonuc: { providerRef: string | null; providerCode: string | null; authCode: string | null; maskedPan: string | null; cardBrand: string | null },
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const islem = await tx.posTransaction.findUniqueOrThrow({
          where: { id: transactionId },
        });

        const payment = await tx.payment.create({
          data: {
            tenantId: islem.tenantId,
            companyId: islem.companyId,
            method: PaymentMethodEnum.CREDIT_CARD,
            status: PaymentStatusEnum.PENDING,
            amount: islem.amount,
            currency: islem.currency,
            receivedAt: new Date(),
            reference: sonuc.providerRef,
            note: sonuc.maskedPan ? `Kart: ${sonuc.maskedPan}` : null,
            recordedByUserId: islem.initiatedByUserId,
            providerRef: sonuc.providerRef,
          },
          include: PAYMENT_INCLUDE,
        });

        const allocations = Array.isArray(islem.requestedAllocations)
          ? (islem.requestedAllocations as unknown as { entryId: string; amount: number }[])
          : undefined;

        await this.payments.settleExternal(
          tx,
          payment,
          allocations && allocations.length > 0 ? allocations : undefined,
        );

        await tx.posTransaction.update({
          where: { id: islem.id },
          data: {
            status: PosStatusEnum.SUCCEEDED,
            providerRef: sonuc.providerRef,
            providerCode: sonuc.providerCode,
            authCode: sonuc.authCode,
            maskedPan: sonuc.maskedPan,
            cardBrand: sonuc.cardBrand,
            paymentId: payment.id,
            completedAt: new Date(),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 },
    );
  }

  private async resolveTenantId(tenantCode: string): Promise<string | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { code: tenantCode },
      select: { id: true },
    });

    return tenant?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Sorgulama
  // -------------------------------------------------------------------------

  async get(principal: AuthenticatedPrincipal, transactionId: string): Promise<PosTransactionView> {
    const islem = await this.prisma.posTransaction.findFirst({
      where: { id: transactionId, tenantId: principal.tenantId },
    });

    if (!islem) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Ödeme işlemi bulunamadı.');
    }

    await this.scope.resolve(principal, islem.companyId);

    return {
      id: islem.id,
      status: islem.status,
      statusLabel: POS_TRANSACTION_STATUS_LABELS[islem.status],
      amount: islem.amount.toNumber(),
      currency: islem.currency,
      installment: islem.installment,
      maskedPan: islem.maskedPan,
      cardBrand: islem.cardBrand,
      bankName: islem.bankName,
      providerRef: islem.providerRef,
      errorCode: islem.errorCode,
      errorMessage: islem.errorMessage,
      paymentId: islem.paymentId,
      createdAt: islem.createdAt.toISOString(),
      completedAt: islem.completedAt?.toISOString() ?? null,
    };
  }
}
