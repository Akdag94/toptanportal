/**
 * ToptanPortal - Siparis Numarasi Uretimi
 *
 * Bicim: SP-YYYY-NNNNNN  (ornek: SP-2026-000417)
 *
 * Numara kiraci ve yil basina bosluksuz artar. Bosluk, "silinmis siparis var mi"
 * sorusunu dogurur; ticari denetimde aciklanmasi gereken bir anomalidir.
 *
 * Es zamanlilik: `pg_advisory_xact_lock` ile kiraci bazinda seri hale getirilir.
 * Kilit islem sonunda kendiliginden birakilir; kilit kiraci bazinda oldugu icin
 * farkli toptancilarin siparisleri birbirini beklemez.
 */

import { Injectable } from '@nestjs/common';
import type { PrismaTransactionClient } from '@toptanportal/db';

const PREFIX = 'SP';
const SEQUENCE_WIDTH = 6;

@Injectable()
export class OrderNumberService {
  /** DAIMA bir islem (transaction) icinde cagirilir - kilit islem omurludur. */
  async next(tx: PrismaTransactionClient, tenantId: string, at: Date = new Date()): Promise<string> {
    const year = at.getFullYear();
    const prefix = `${PREFIX}-${year}-`;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:order-number`}))`;

    const last = await tx.order.findFirst({
      where: { tenantId, orderNumber: { startsWith: prefix } },
      orderBy: { orderNumber: 'desc' },
      select: { orderNumber: true },
    });

    const lastSequence = last ? Number.parseInt(last.orderNumber.slice(prefix.length), 10) : 0;
    const next = Number.isFinite(lastSequence) ? lastSequence + 1 : 1;

    return `${prefix}${String(next).padStart(SEQUENCE_WIDTH, '0')}`;
  }
}
