/**
 * ToptanPortal - Siparis Servisi
 *
 * SIPARIS OLUSTURMA SIRASI (sira ticari olarak anlamlidir):
 *   1. Sepet sunucuda YENIDEN fiyatlandirilir - istemciden gelen tutara asla
 *      guvenilmez.
 *   2. Cari risk kontrolu (blokaj, vadesi gecmis borc, kredi limiti).
 *   3. Harcama limiti -> siparis dogrudan mi gidecek yoksa onaya mi dusecek.
 *   4. TEK ISLEM icinde: numara uretimi, siparis+satirlar, stok rezervasyonu
 *      (satir kilidi ile), outbox olayi, sepetin bosaltilmasi, denetim kaydi.
 *
 * Adim 4'un tamami tek islemdir: stok ayrilip siparis yazilamamasi ya da
 * siparis yazilip Logo olayinin dusmemesi mumkun degildir.
 *
 * KOR SIPARIS: Tutarlar sunucuda daima hesaplanir (belge ve onay bunlara
 * dayanir) ama yetkisiz kullaniciya donen gorunume KONMAZ.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  OrderChannel,
  OrderStatus,
  Prisma,
  UserStatus,
  type PrismaTransactionClient,
} from '@toptanportal/db';
import {
  AuditAction,
  ErrorCode,
  NotificationTopic,
  ORDER_STATUS_LABELS,
  Permission,
  ROLE_PERMISSIONS,
  UserRole,
  canSeeFinancials,
  roleHasPermission,
  type OrderListQuery,
  type OrderView,
  type PlaceOrderRequest,
  type PlaceOrderResult,
  type StockShortage,
} from '@toptanportal/contracts';

import { AuditService } from '../common/audit/audit.service';
import { ApiException } from '../common/exceptions/api.exception';
import { OutboxEventType, OutboxService } from '../common/outbox/outbox.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { requireCompanyContext } from '../common/context/company-context';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { CartService } from '../cart/cart.service';
import { Decimal, type PricedLine } from '../pricing/pricing.types';
import { NotificationService } from '../notification/notification.service';
import { StockService, StockShortageError } from '../stock/stock.service';
import { OrderNumberService } from './order-number.service';
import { SpendingLimitService } from './spending-limit.service';

const ORDER_INCLUDE = {
  company: { select: { id: true, title: true } },
  warehouse: { select: { name: true } },
  createdBy: { select: { fullName: true } },
  approvedBy: { select: { fullName: true } },
  lines: {
    orderBy: { lineNumber: 'asc' },
    select: {
      lineNumber: true,
      productId: true,
      productCode: true,
      productName: true,
      unitCode: true,
      quantity: true,
      baseQuantity: true,
      unitPrice: true,
      grossAmount: true,
      discountTotal: true,
      netAmount: true,
      vatRate: true,
      vatAmount: true,
      lineTotal: true,
      note: true,
    },
  },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

/** Iptal edilebilir durumlar - Logo'ya iletilmis siparis portalden iptal edilemez. */
const CANCELLABLE: OrderStatus[] = [OrderStatus.PENDING_APPROVAL, OrderStatus.QUEUED];

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly stock: StockService,
    private readonly orderNumber: OrderNumberService,
    private readonly spendingLimit: SpendingLimitService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Siparisi onaylayabilecek kisiler.
   *
   * Onay yetkisi ROLDEN gelir; listeyi rol matrisinden turetmek, ileride yeni
   * bir isletme rolu eklendiginde bu sorgunun sessizce eksik kalmasini onler.
   */
  private static readonly ONAYCI_ROLLERI = (Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter(
    (role) =>
      role !== UserRole.SUPER_ADMIN &&
      role !== UserRole.SALES_REP &&
      ROLE_PERMISSIONS[role].includes(Permission.ORDER_APPROVE),
  );

  // -------------------------------------------------------------------------
  // Siparis olusturma
  // -------------------------------------------------------------------------

  async place(
    principal: AuthenticatedPrincipal,
    request: PlaceOrderRequest,
  ): Promise<PlaceOrderResult> {
    const companyId = requireCompanyContext(principal);
    const canSeePrices = canSeeFinancials(principal.role);
    const owner = {
      tenantId: principal.tenantId,
      companyId,
      userId: principal.userId,
      canSeePrices,
    };

    // Tutarlar kor moddaki kullanici icin de hesaplanir; yalnizca yanita konmaz.
    const snapshot = await this.cart.buildSnapshot(owner, { forcePricing: true });

    if (snapshot.lines.length === 0) {
      throw ApiException.unprocessable(ErrorCode.VALIDATION_FAILED, 'Sepetiniz boş.');
    }

    if (snapshot.droppedLines > 0) {
      throw ApiException.unprocessable(
        ErrorCode.PRODUCT_UNAVAILABLE,
        'Sepetinizdeki bazı ürünler artık sipariş edilemiyor. Lütfen sepeti gözden geçirin.',
      );
    }

    const priced = snapshot.priced;

    if (!priced) {
      throw ApiException.internal(ErrorCode.INTERNAL_ERROR, 'Sipariş tutarı hesaplanamadı.');
    }

    await this.assertCompanyCanOrder(principal.tenantId, companyId, priced.grandTotal);

    const warehouse = await this.stock.resolveWarehouse({
      tenantId: principal.tenantId,
      companyId,
      warehouseId: request.warehouseId ?? null,
    });

    const decision = await this.spendingLimit.evaluate({
      userId: principal.userId,
      companyId,
      grandTotal: priced.grandTotal,
      canPlaceDirectly: roleHasPermission(principal.role, Permission.ORDER_PLACE),
    });

    const status = decision.requiresApproval ? OrderStatus.PENDING_APPROVAL : OrderStatus.QUEUED;

    const order = await this.prisma
      .$transaction(
        async (tx) => {
          const orderNumber = await this.orderNumber.next(tx, principal.tenantId);

          const created = await tx.order.create({
            data: {
              tenantId: principal.tenantId,
              companyId,
              warehouseId: warehouse.id,
              orderNumber,
              createdByUserId: principal.userId,
              onBehalfOfSalesRepId: principal.masqueradeCompanyId ? principal.userId : null,
              status,
              channel: this.resolveChannel(principal),
              grossTotal: priced.grossTotal,
              discountTotal: priced.discountTotal,
              netTotal: priced.netTotal,
              vatTotal: priced.vatTotal,
              grandTotal: priced.grandTotal,
              currency: priced.currency,
              priceListId: priced.priceListId,
              priceListName: priced.priceListName,
              customerNote: request.customerNote ?? snapshot.note,
              requestedDeliveryDate: request.requestedDeliveryDate
                ? new Date(request.requestedDeliveryDate)
                : null,
              lines: {
                create: priced.lines.map((line, index) => this.toLineData(line, index + 1)),
              },
              statusHistory: {
                create: { toStatus: status, actorUserId: principal.userId },
              },
            },
            include: ORDER_INCLUDE,
          });

          await this.stock.reserve(tx, {
            orderId: created.id,
            warehouseId: warehouse.id,
            requests: priced.lines.map((line) => ({
              productId: line.productId,
              productName: line.productName,
              unitCode: line.unitCode,
              baseQuantity: line.baseQuantity,
              requestedQuantity: line.quantity,
            })),
            pendingApproval: decision.requiresApproval,
          });

          if (!decision.requiresApproval) {
            await this.publishOrderPlaced(tx, created);
          }

          await this.cart.clearWithin(tx, snapshot.cartId);

          await this.audit.record(
            {
              tenantId: principal.tenantId,
              action: decision.requiresApproval
                ? AuditAction.ORDER_SUBMITTED_FOR_APPROVAL
                : AuditAction.ORDER_PLACED,
              resourceType: 'Order',
              resourceId: created.id,
              companyId,
              payload: {
                orderNumber: created.orderNumber,
                lineCount: priced.lines.length,
                grandTotal: priced.grandTotal.toString(),
                currency: priced.currency,
                priceListName: priced.priceListName,
                warehouse: warehouse.name,
                approvalReason: decision.reason,
              },
            },
            tx,
          );

          /* Onaya dusen siparisin stogu REZERVEDIR. Onaycinin haberi olmazsa
             o stok, kimsenin bakmadigi bir siparis icin depoda bekler -
             toptancinin en pahali sessiz kaybi budur. Bildirim bu yuzden
             siparisle AYNI ISLEMDE yazilir: siparis var, bildirim yok hali
             tam olarak o kaybi uretir. */
          if (decision.requiresApproval) {
            await this.onayBildirimi(tx, created, priced.lines.length, principal.userId);
          }

          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 },
      )
      .catch((error: unknown) => {
        throw this.translateStockShortage(error, canSeePrices);
      });

    return {
      order: this.toView(order, canSeePrices),
      requiresApproval: decision.requiresApproval,
      message: decision.requiresApproval
        ? 'Siparişiniz işletme yetkilinizin onayına gönderildi.'
        : 'Siparişiniz alındı ve muhasebe sistemine iletiliyor.',
    };
  }

  // -------------------------------------------------------------------------
  // Onay akisi
  // -------------------------------------------------------------------------

  async approve(principal: AuthenticatedPrincipal, orderId: string): Promise<OrderView> {
    const order = await this.loadForCompany(principal, orderId);

    if (order.status !== OrderStatus.PENDING_APPROVAL) {
      throw ApiException.conflict(
        ErrorCode.ORDER_ALREADY_PROCESSED,
        'Bu sipariş onay bekleyen durumda değil.',
      );
    }

    // Kendi siparisini onaylamak, limitleri anlamsiz kilar.
    if (order.createdByUserId === principal.userId) {
      throw ApiException.forbidden(
        ErrorCode.FORBIDDEN,
        'Kendi oluşturduğunuz siparişi onaylayamazsınız.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.QUEUED,
          approvedByUserId: principal.userId,
          approvedAt: new Date(),
          statusHistory: {
            create: {
              fromStatus: OrderStatus.PENDING_APPROVAL,
              toStatus: OrderStatus.QUEUED,
              actorUserId: principal.userId,
            },
          },
        },
        include: ORDER_INCLUDE,
      });

      await this.publishOrderPlaced(tx, next);

      await this.audit.record(
        {
          tenantId: principal.tenantId,
          action: AuditAction.ORDER_APPROVED,
          resourceType: 'Order',
          resourceId: next.id,
          companyId: next.companyId,
          payload: {
            orderNumber: next.orderNumber,
            grandTotal: next.grandTotal.toString(),
            createdByUserId: next.createdByUserId,
          },
        },
        tx,
      );

      await this.durumBildirimi(tx, next, principal.userId, null);

      return next;
    });

    return this.toView(updated, canSeeFinancials(principal.role));
  }

  async reject(
    principal: AuthenticatedPrincipal,
    orderId: string,
    reason: string,
  ): Promise<OrderView> {
    const order = await this.loadForCompany(principal, orderId);

    if (order.status !== OrderStatus.PENDING_APPROVAL) {
      throw ApiException.conflict(
        ErrorCode.ORDER_ALREADY_PROCESSED,
        'Bu sipariş onay bekleyen durumda değil.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Once stok serbest birakilir; reddedilen siparis stogu tutmaya devam
      // ederse depo fiilen kilitlenir.
      await this.stock.release(tx, order.id, 'REJECTED');

      const next = await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.REJECTED,
          rejectReason: reason,
          approvedByUserId: principal.userId,
          statusHistory: {
            create: {
              fromStatus: OrderStatus.PENDING_APPROVAL,
              toStatus: OrderStatus.REJECTED,
              reason,
              actorUserId: principal.userId,
            },
          },
        },
        include: ORDER_INCLUDE,
      });

      await this.audit.record(
        {
          tenantId: principal.tenantId,
          action: AuditAction.ORDER_REJECTED,
          resourceType: 'Order',
          resourceId: next.id,
          companyId: next.companyId,
          payload: { orderNumber: next.orderNumber, reason },
        },
        tx,
      );

      /* Red sebebi bildirimin EN DEGERLI parcasidir: "reddedildi" diyen bir
         mesaj, kullaniciyi telefona sarilmaktan kurtarmaz. */
      await this.durumBildirimi(tx, next, principal.userId, reason);

      return next;
    });

    return this.toView(updated, canSeeFinancials(principal.role));
  }

  async cancel(principal: AuthenticatedPrincipal, orderId: string): Promise<OrderView> {
    const order = await this.loadForCompany(principal, orderId);

    if (!CANCELLABLE.includes(order.status)) {
      throw ApiException.conflict(
        ErrorCode.ORDER_ALREADY_PROCESSED,
        'Bu sipariş muhasebe sistemine iletildiği için portalden iptal edilemez. Lütfen satış temsilcinizle görüşün.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.stock.release(tx, order.id, 'CANCELLED');

      const next = await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          statusHistory: {
            create: {
              fromStatus: order.status,
              toStatus: OrderStatus.CANCELLED,
              actorUserId: principal.userId,
            },
          },
        },
        include: ORDER_INCLUDE,
      });

      // Kuyruga girmis siparis icin Logo tarafina da iptal bildirilir.
      if (order.status === OrderStatus.QUEUED) {
        await this.outbox.publish(tx, {
          tenantId: principal.tenantId,
          aggregateType: 'Order',
          aggregateId: next.id,
          eventType: OutboxEventType.ORDER_CANCELLED,
          payload: { orderId: next.id, orderNumber: next.orderNumber },
        });
      }

      await this.audit.record(
        {
          tenantId: principal.tenantId,
          action: AuditAction.ORDER_CANCELLED,
          resourceType: 'Order',
          resourceId: next.id,
          companyId: next.companyId,
          payload: { orderNumber: next.orderNumber, previousStatus: order.status },
        },
        tx,
      );

      await this.durumBildirimi(tx, next, principal.userId, null);

      return next;
    });

    return this.toView(updated, canSeeFinancials(principal.role));
  }

  // -------------------------------------------------------------------------
  // Sorgulama
  // -------------------------------------------------------------------------

  async list(
    principal: AuthenticatedPrincipal,
    query: OrderListQuery,
  ): Promise<{ items: OrderView[]; nextCursor: string | null }> {
    const where = this.buildScopeFilter(principal);

    if (query.status) {
      where.status = query.status as OrderStatus;
    }

    if (query.from || query.to) {
      where.submittedAt = {
        ...(query.from ? { gte: new Date(`${query.from}T00:00:00`) } : {}),
        // Bitis tarihi DAHILDIR; kullanici "1-5 Mart" derken 5 Mart'i kapsar.
        ...(query.to ? { lt: nextDay(query.to) } : {}),
      };
    }

    const rows = await this.prisma.order.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const canSeePrices = canSeeFinancials(principal.role);

    return {
      items: page.map((row) => this.toView(row, canSeePrices)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async getById(principal: AuthenticatedPrincipal, orderId: string): Promise<OrderView> {
    const order = await this.loadForCompany(principal, orderId);
    return this.toView(order, canSeeFinancials(principal.role));
  }

  // -------------------------------------------------------------------------
  // Yardimcilar
  // -------------------------------------------------------------------------

  /**
   * Onay bekleyen siparis bildirimi.
   *
   * Siparisi GONDEREN kisi listeden cikarilir: kendi siparisini onaylayamayan
   * kullaniciya "onayiniz bekleniyor" yazmak, yapamayacagi bir is icin
   * hatirlatma gondermektir.
   */
  private async onayBildirimi(
    tx: PrismaTransactionClient,
    order: OrderRow,
    lineCount: number,
    createdByUserId: string,
  ): Promise<void> {
    const onaycilar = await tx.user.findMany({
      where: {
        companyId: order.companyId,
        tenantId: order.tenantId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        role: { in: OrderService.ONAYCI_ROLLERI },
        id: { not: createdByUserId },
      },
      select: { id: true },
    });

    await this.notifications.enqueue(
      {
        tenantId: order.tenantId,
        payload: {
          topic: NotificationTopic.ORDER_APPROVAL_PENDING,
          orderNumber: order.orderNumber,
          requestedByName: order.createdBy?.fullName ?? 'Bir kullanıcı',
          grandTotal: order.grandTotal.toNumber(),
          currency: order.currency,
          lineCount,
        },
        recipientUserIds: onaycilar.map((onayci) => onayci.id),
        dedupeKey: `order:${order.id}:approval`,
        relatedType: 'Order',
        relatedId: order.id,
      },
      tx,
    );
  }

  /**
   * Siparis durumu bildirimi.
   *
   * Alici, siparisi GIREN kisidir - durumu degistiren kisi degil. Kendi
   * yaptigi islemi kendisine bildirmek, bildirimleri okunmadan silinen bir
   * yigina cevirir.
   */
  private async durumBildirimi(
    tx: PrismaTransactionClient,
    order: OrderRow,
    actorUserId: string,
    reason: string | null,
  ): Promise<void> {
    if (order.createdByUserId === actorUserId) return;

    await this.notifications.enqueue(
      {
        tenantId: order.tenantId,
        payload: {
          topic: NotificationTopic.ORDER_STATUS,
          orderNumber: order.orderNumber,
          statusLabel: ORDER_STATUS_LABELS[order.status],
          companyTitle: order.company.title,
          grandTotal: order.grandTotal.toNumber(),
          currency: order.currency,
          reason,
        },
        recipientUserIds: [order.createdByUserId],
        /* Durum anahtara girer: ayni siparis icin onay ve iptal iki ayri
           bildirimdir, ikincisinin tekillestirmeye takilmamasi gerekir. */
        dedupeKey: `order:${order.id}:${order.status}`,
        relatedType: 'Order',
        relatedId: order.id,
      },
      tx,
    );
  }

  /**
   * Cari risk kontrolu.
   *
   * Buradaki degerler Logo'dan senkronize edilmis KOPYADIR; nihai otorite
   * Logo'dur ve kopru devreye girdiginde siparis aninda canli sorgulanacaktir.
   * Kopya ile yapilan bu kontrol, acikca riskli siparisin sisteme hic
   * girmemesini saglar.
   */
  private async assertCompanyCanOrder(
    tenantId: string,
    companyId: string,
    grandTotal: Decimal,
  ): Promise<void> {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId },
      select: {
        id: true,
        title: true,
        isActive: true,
        isBlocked: true,
        blockReason: true,
        creditLimit: true,
        cachedBalance: true,
        cachedOverdueAmount: true,
      },
    });

    if (!company || !company.isActive) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'İşletme bulunamadı.');
    }

    if (company.isBlocked) {
      throw ApiException.forbidden(
        ErrorCode.FORBIDDEN,
        company.blockReason ?? 'Hesabınız sipariş vermeye kapalıdır. Lütfen yetkilinizle görüşün.',
      );
    }

    if (new Decimal(company.cachedOverdueAmount).greaterThan(0)) {
      throw ApiException.unprocessable(ErrorCode.OVERDUE_INVOICE_BLOCK);
    }

    const creditLimit = new Decimal(company.creditLimit);

    // Limit 0 ise "limitsiz" degil, "acik hesap yok" anlamina gelmez; sifir
    // limit tanimlanmamis demektir ve kontrol uygulanmaz.
    if (creditLimit.greaterThan(0)) {
      const projected = new Decimal(company.cachedBalance).plus(grandTotal);

      if (projected.greaterThan(creditLimit)) {
        throw ApiException.unprocessable(ErrorCode.CREDIT_LIMIT_EXCEEDED);
      }
    }
  }

  private async publishOrderPlaced(tx: PrismaTransactionClient, order: OrderRow): Promise<void> {
    await this.outbox.publish(tx, {
      tenantId: order.tenantId,
      aggregateType: 'Order',
      aggregateId: order.id,
      eventType: OutboxEventType.ORDER_PLACED,
      payload: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        companyId: order.companyId,
        warehouseId: order.warehouseId,
        currency: order.currency,
        grandTotal: order.grandTotal.toString(),
        requestedDeliveryDate: order.requestedDeliveryDate?.toISOString() ?? null,
        lines: order.lines.map((line) => ({
          lineNumber: line.lineNumber,
          productCode: line.productCode,
          unitCode: line.unitCode,
          quantity: line.quantity.toString(),
          baseQuantity: line.baseQuantity.toString(),
          unitPrice: line.unitPrice.toString(),
          discountTotal: line.discountTotal.toString(),
          vatRate: line.vatRate.toString(),
        })),
      },
    });
  }

  private toLineData(line: PricedLine, lineNumber: number): Prisma.OrderLineCreateWithoutOrderInput {
    return {
      lineNumber,
      product: { connect: { id: line.productId } },
      unit: { connect: { id: line.unitId } },
      productCode: line.productCode,
      productName: line.productName,
      unitCode: line.unitCode,
      quantity: line.quantity,
      conversionFactor: line.conversionFactor,
      baseQuantity: line.baseQuantity,
      unitPrice: line.unitPrice,
      grossAmount: line.grossAmount,
      discountTotal: line.discountTotal,
      netAmount: line.netAmount,
      vatRate: line.vatRate,
      vatAmount: line.vatAmount,
      lineTotal: line.lineTotal,
      appliedDiscounts: line.appliedDiscounts as unknown as Prisma.InputJsonValue,
      note: line.note,
    };
  }

  /** Siparisin hangi kanaldan girildigi - saha analitigi ve ispat icin. */
  private resolveChannel(principal: AuthenticatedPrincipal): OrderChannel {
    if (principal.masqueradeCompanyId) return OrderChannel.SALES_REP;
    return OrderChannel.WEB;
  }

  /**
   * Gorunurluk kapsami:
   *   ORDER_VIEW_ALL     -> kiracinin tum siparisleri (yonetim)
   *   ORDER_VIEW_COMPANY -> isletmenin tum siparisleri (ana yetkili, muhasebeci)
   *   ORDER_VIEW_OWN     -> yalnizca kullanicinin kendi siparisleri (alt yetkili)
   */
  private buildScopeFilter(principal: AuthenticatedPrincipal): Prisma.OrderWhereInput {
    const where: Prisma.OrderWhereInput = { tenantId: principal.tenantId };

    if (roleHasPermission(principal.role, Permission.ORDER_VIEW_ALL)) {
      return where;
    }

    if (roleHasPermission(principal.role, Permission.ORDER_VIEW_COMPANY)) {
      where.companyId = requireCompanyContext(principal);
      return where;
    }

    where.companyId = requireCompanyContext(principal);
    where.createdByUserId = principal.userId;
    return where;
  }

  private async loadForCompany(
    principal: AuthenticatedPrincipal,
    orderId: string,
  ): Promise<OrderRow> {
    const order = await this.prisma.order.findFirst({
      where: { ...this.buildScopeFilter(principal), id: orderId },
      include: ORDER_INCLUDE,
    });

    if (!order) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Sipariş bulunamadı.');
    }

    return order;
  }

  /**
   * Stok yetersizligini istemcinin isleyebilecegi hataya cevirir.
   * KOR SIPARIS: mevcut miktar (`available`) yetkisiz kullaniciya GONDERILMEZ;
   * yalnizca hangi urunde sikinti oldugu bildirilir.
   */
  private translateStockShortage(error: unknown, canSeePrices: boolean): unknown {
    if (!(error instanceof StockShortageError)) {
      return error;
    }

    const shortages: StockShortage[] = error.shortages.map((shortage) => ({
      productId: shortage.productId,
      productName: shortage.productName,
      unitCode: shortage.unitCode,
      requested: shortage.requested,
      ...(canSeePrices ? { available: shortage.available } : {}),
    }));

    const names = shortages.map((s) => s.productName).join(', ');

    this.logger.warn(`Stok yetersizliği nedeniyle sipariş reddedildi: ${names}`);

    return ApiException.unprocessable(
      ErrorCode.STOCK_INSUFFICIENT,
      `Şu ürünlerde yeterli stok bulunmuyor: ${names}`,
      undefined,
      { shortages },
    );
  }

  private toView(order: OrderRow, canSeePrices: boolean): OrderView {
    const view: OrderView = {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      statusLabel: ORDER_STATUS_LABELS[order.status],
      channel: order.channel,
      companyId: order.companyId,
      companyTitle: order.company.title,
      warehouseName: order.warehouse.name,
      createdByName: order.createdBy.fullName,
      approvedByName: order.approvedBy?.fullName ?? null,
      customerNote: order.customerNote,
      rejectReason: order.rejectReason,
      logoOrderNumber: order.logoOrderNumber,
      submittedAt: order.submittedAt.toISOString(),
      approvedAt: order.approvedAt?.toISOString() ?? null,
      confirmedAt: order.confirmedAt?.toISOString() ?? null,
      requestedDeliveryDate: order.requestedDeliveryDate?.toISOString().slice(0, 10) ?? null,
      blindOrderMode: !canSeePrices,
      lines: order.lines.map((line) => {
        const base = {
          lineNumber: line.lineNumber,
          productId: line.productId,
          productCode: line.productCode,
          productName: line.productName,
          unitCode: line.unitCode,
          quantity: new Decimal(line.quantity).toNumber(),
          baseQuantity: new Decimal(line.baseQuantity).toNumber(),
          note: line.note,
        };

        if (!canSeePrices) return base;

        return {
          ...base,
          unitPrice: new Decimal(line.unitPrice).toNumber(),
          grossAmount: new Decimal(line.grossAmount).toNumber(),
          discountTotal: new Decimal(line.discountTotal).toNumber(),
          netAmount: new Decimal(line.netAmount).toNumber(),
          vatRate: new Decimal(line.vatRate).toNumber(),
          vatAmount: new Decimal(line.vatAmount).toNumber(),
          lineTotal: new Decimal(line.lineTotal).toNumber(),
        };
      }),
    };

    if (!canSeePrices) {
      return view;
    }

    view.grossTotal = new Decimal(order.grossTotal).toNumber();
    view.discountTotal = new Decimal(order.discountTotal).toNumber();
    view.netTotal = new Decimal(order.netTotal).toNumber();
    view.vatTotal = new Decimal(order.vatTotal).toNumber();
    view.grandTotal = new Decimal(order.grandTotal).toNumber();
    view.currency = order.currency;

    return view;
  }
}

function nextDay(isoDate: string): Date {
  const date = new Date(`${isoDate}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return date;
}
