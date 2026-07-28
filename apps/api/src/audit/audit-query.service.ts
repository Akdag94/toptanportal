/**
 * ToptanPortal API - Denetim Kaydi Sorgulama
 *
 * Denetim kaydi APPEND-ONLY'dir ve bu servis yalnizca OKUR. Yazma yolu
 * `AuditService`tedir; ikisini ayirmak bilinclidir - sorgulama ucuna yazma
 * yetenegi eklemek, delil zincirini uygulama hatasina acik hale getirir.
 *
 * ZINCIR DOGRULAMASI ekrandan tetiklenebilir ama SINIRLIDIR: son N kaydi
 * tarar. Tam tarama komut satirindadir (`verify-audit`), cunku milyonlarca
 * kayitlik bir zinciri HTTP istegi icinde dogrulamak zaman asimina ugrar ve
 * yarim kalan bir dogrulama, "zincir bozuk" gibi gorunerek yanlis alarm uretir.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, computeAuditHash } from '@toptanportal/db';
import {
  AUDIT_ACTION_LABELS,
  type AuditEntry,
  type AuditPage,
  type AuditQuery,
  type AuditVerifyResult,
} from '@toptanportal/contracts';

import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';

/** Ekrandan tetiklenen dogrulamada taranacak azami kayit. */
const DOGRULAMA_SINIRI = 5000;

@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(principal: AuthenticatedPrincipal, query: AuditQuery): Promise<AuditPage> {
    const where: Prisma.AuditLogWhereInput = {
      tenantId: principal.tenantId,
      ...(query.action ? { action: { contains: query.action, mode: 'insensitive' } } : {}),
      ...(query.actorEmail
        ? { actorEmail: { contains: query.actorEmail, mode: 'insensitive' } }
        : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
    };

    const [kayitlar, toplam, zincirBasi] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        /* Sira numarasina gore siralanir, zamana gore DEGIL: ayni mikrosaniyede
           yazilan iki kaydin sirasi zamanla belirlenemez ve delil sunumunda
           sira, zincirin kendisidir. */
        orderBy: { seq: 'desc' },
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.auditLog.count({ where }),
      this.prisma.auditChainHead.findUnique({ where: { tenantId: principal.tenantId } }),
    ]);

    return {
      entries: kayitlar.map((kayit) => this.toView(kayit)),
      totalCount: toplam,
      hasMore: query.offset + kayitlar.length < toplam,
      chainHead: zincirBasi
        ? { lastSeq: zincirBasi.lastSeq.toString(), lastHash: zincirBasi.lastHash }
        : null,
    };
  }

  /**
   * Zincirin son bolumunu dogrular.
   *
   * Her kaydin ozeti, bir onceki ozet ve kendi kanonik govdesinden yeniden
   * hesaplanir. Tek bir alanin sonradan degistirilmesi, o kayittan itibaren
   * TUM zinciri kirar - bu yuzden ilk kirilma noktasi raporlanir; sonrasindaki
   * uyumsuzluklar ayni tek degisikligin sonucudur.
   */
  async verify(principal: AuthenticatedPrincipal): Promise<AuditVerifyResult> {
    const kayitlar = await this.prisma.auditLog.findMany({
      where: { tenantId: principal.tenantId },
      orderBy: { seq: 'desc' },
      take: DOGRULAMA_SINIRI,
    });

    if (kayitlar.length === 0) {
      return {
        valid: true,
        verifiedCount: 0,
        brokenAtSeq: null,
        message: 'Denetim kaydı bulunmuyor.',
      };
    }

    /* Zincir ileri dogru dogrulanir; sorgu geriye dogru geldigi icin ters
       cevrilir. */
    const sirali = [...kayitlar].reverse();

    for (const kayit of sirali) {
      const beklenen = computeAuditHash(kayit.prevHash, {
        tenantId: kayit.tenantId,
        seq: kayit.seq,
        occurredAt: kayit.occurredAt,
        actorType: kayit.actorType,
        actorUserId: kayit.actorUserId,
        actorRole: kayit.actorRole,
        actorEmail: kayit.actorEmail,
        onBehalfOfCompanyId: kayit.onBehalfOfCompanyId,
        companyId: kayit.companyId,
        action: kayit.action,
        resourceType: kayit.resourceType,
        resourceId: kayit.resourceId,
        outcome: kayit.outcome,
        ip: kayit.ip,
        userAgent: kayit.userAgent,
        requestId: kayit.requestId,
        sessionId: kayit.sessionId,
        payload: kayit.payload,
      });

      if (beklenen !== kayit.hash) {
        return {
          valid: false,
          verifiedCount: sirali.length,
          brokenAtSeq: kayit.seq.toString(),
          message: `Zincir ${kayit.seq} numaralı kayıtta kırılmış. Bu kayıt veya öncesindeki bir kayıt değiştirilmiş olabilir.`,
        };
      }
    }

    return {
      valid: true,
      verifiedCount: sirali.length,
      brokenAtSeq: null,
      message: `Son ${sirali.length} kayıt doğrulandı; zincir bütünlüğü korunuyor. Tam denetim için "verify-audit" komutunu çalıştırın.`,
    };
  }

  private toView(kayit: Prisma.AuditLogGetPayload<object>): AuditEntry {
    return {
      id: kayit.id.toString(),
      seq: kayit.seq.toString(),
      occurredAt: kayit.occurredAt.toISOString(),
      actorType: kayit.actorType,
      actorEmail: kayit.actorEmail,
      actorRole: kayit.actorRole,
      action: kayit.action,
      actionLabel: AUDIT_ACTION_LABELS[kayit.action] ?? kayit.action,
      outcome: kayit.outcome,
      resourceType: kayit.resourceType,
      resourceId: kayit.resourceId,
      companyId: kayit.companyId,
      ip: kayit.ip,
      requestId: kayit.requestId,
      payload: (kayit.payload ?? {}) as Record<string, unknown>,
      hash: kayit.hash,
    };
  }
}
