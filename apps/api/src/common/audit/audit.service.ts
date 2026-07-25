/**
 * ToptanPortal - Yasal Delil Loglama Servisi
 *
 * 5651 sayili Kanun ve 5070 sayili Elektronik Imza Kanunu cercevesinde ticari
 * ispat yukumlulugu; her finansal ve ticari aksiyonun degistirilemez sekilde
 * kayit altina alinmasini gerektirir.
 *
 * Butunluk modeli:
 *  * Her kiraci icin bosluksuz `seq` sirasi
 *  * hash(n) = SHA256(prevHash || "." || canonicalJson(kayit))
 *  * audit_logs tablosunda UPDATE/DELETE veritabani trigger'i ile yasak
 *  * Es zamanli yazimlar `pg_advisory_xact_lock` ile kiraci bazinda seri hale
 *    getirilir; boylece iki istek ayni `seq` degerini alamaz.
 *
 * Kilit kiraci bazindadir, global degildir: farkli toptancilarin trafigi
 * birbirini beklemez.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  AuditActorType as AuditActorTypeEnum,
  Prisma,
  type PrismaClient,
  type UserRole as PrismaUserRole,
} from '@toptanportal/db';
import { computeAuditHash } from '@toptanportal/db';
import { AUDIT_GENESIS_HASH, type AuditAction } from '@toptanportal/contracts';

import { PrismaService } from '../prisma/prisma.service';
import { getRequestContext } from '../context/request-context';

/** Payload icine kazara sizabilecek gizli alanlar. */
const REDACTED_PAYLOAD_KEYS: ReadonlySet<string> = new Set(
  [
    'password',
    'newpassword',
    'currentpassword',
    'passwordhash',
    'token',
    'accesstoken',
    'refreshtoken',
    'challengetoken',
    'secret',
    'mfasecret',
    'mfasecretenc',
    'totpsecret',
    'otpauthuri',
    'recoverycodes',
    'code',
    'cardnumber',
    'pan',
    'cvv',
    'cvc',
    'expiry',
    'authorization',
    'cookie',
  ].map((key) => key.toLowerCase()),
);

const MAX_PAYLOAD_DEPTH = 6;

export type AuditTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface AuditRecordInput {
  tenantId: string;
  action: AuditAction;
  outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  resourceType?: string | null;
  resourceId?: string | null;
  companyId?: string | null;
  onBehalfOfCompanyId?: string | null;
  payload?: Record<string, unknown>;
  /** Baglamdan cozulemedigi durumlar icin acik gecis (ornek: basarisiz giris). */
  actorUserId?: string | null;
  actorRole?: PrismaUserRole | null;
  actorEmail?: string | null;
  actorType?: AuditActorTypeEnum;
  occurredAt?: Date;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Kaydi yazar. Basarisiz olursa ISTISNA FIRLATIR.
   * Finansal ve ticari aksiyonlarda kullanilir: log yazilamiyorsa islem de
   * tamamlanmamalidir - delilsiz ticari islem kabul edilemez.
   *
   * @param tx Cagiran zaten bir islem (transaction) icindeyse o istemci verilir;
   *           boylece log ve is verisi ayni atomik birimde yazilir.
   */
  async record(input: AuditRecordInput, tx?: AuditTransactionClient): Promise<void> {
    if (tx) {
      await this.writeWithinTransaction(tx, input);
      return;
    }

    await this.prisma.$transaction(
      async (transaction) => {
        await this.writeWithinTransaction(transaction, input);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10000 },
    );
  }

  /**
   * Kaydi yazmaya calisir, basarisiz olursa yalnizca uyari uretir.
   * Yalnizca is akisini bloke etmemesi gereken telemetri niteligindeki
   * olaylarda kullanilir (ornek: bilinmeyen e-posta ile giris denemesi).
   */
  async recordSafely(input: AuditRecordInput, tx?: AuditTransactionClient): Promise<void> {
    try {
      await this.record(input, tx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Denetim kaydı yazılamadı (${input.action}): ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async writeWithinTransaction(
    tx: AuditTransactionClient,
    input: AuditRecordInput,
  ): Promise<void> {
    const context = getRequestContext();
    const principal = context?.principal ?? null;

    // Kiraci bazli seri hale getirme. Islem bitene kadar tutulur.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.tenantId})::bigint)`;

    const head = await tx.auditChainHead.upsert({
      where: { tenantId: input.tenantId },
      update: {},
      create: { tenantId: input.tenantId },
    });

    const seq = head.lastSeq + 1n;
    const prevHash = head.lastHash || AUDIT_GENESIS_HASH;
    const occurredAt = input.occurredAt ?? new Date();

    const actorUserId =
      input.actorUserId !== undefined ? input.actorUserId : (principal?.userId ?? null);
    const actorRole =
      input.actorRole !== undefined
        ? input.actorRole
        : ((principal?.role as PrismaUserRole | undefined) ?? null);
    const actorEmail =
      input.actorEmail !== undefined ? input.actorEmail : (principal?.email ?? null);

    const companyId =
      input.companyId !== undefined ? input.companyId : (principal?.companyId ?? null);
    const onBehalfOfCompanyId =
      input.onBehalfOfCompanyId !== undefined
        ? input.onBehalfOfCompanyId
        : (principal?.masqueradeCompanyId ?? null);

    const payload = sanitizePayload(input.payload ?? {}, 0);

    const hashInput = {
      tenantId: input.tenantId,
      seq,
      occurredAt,
      actorType: input.actorType ?? AuditActorTypeEnum.USER,
      actorUserId,
      actorRole,
      actorEmail,
      onBehalfOfCompanyId,
      companyId,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      outcome: input.outcome ?? 'SUCCESS',
      ip: context?.ip ?? null,
      userAgent: context?.userAgent ?? null,
      requestId: context?.requestId ?? null,
      sessionId: principal?.sessionId ?? null,
      payload,
    };

    const hash = computeAuditHash(prevHash, hashInput);

    await tx.auditLog.create({
      data: {
        tenantId: hashInput.tenantId,
        seq: hashInput.seq,
        occurredAt: hashInput.occurredAt,
        actorType: hashInput.actorType,
        actorUserId: hashInput.actorUserId,
        actorRole: hashInput.actorRole,
        actorEmail: hashInput.actorEmail,
        onBehalfOfCompanyId: hashInput.onBehalfOfCompanyId,
        companyId: hashInput.companyId,
        action: hashInput.action,
        resourceType: hashInput.resourceType,
        resourceId: hashInput.resourceId,
        outcome: hashInput.outcome,
        ip: hashInput.ip,
        userAgent: hashInput.userAgent,
        requestId: hashInput.requestId,
        sessionId: hashInput.sessionId,
        payload: payload as Prisma.InputJsonValue,
        prevHash,
        hash,
      },
    });

    await tx.auditChainHead.update({
      where: { tenantId: input.tenantId },
      data: { lastSeq: seq, lastHash: hash },
    });
  }
}

/**
 * Payload'i denetim kaydina uygun hale getirir:
 *  * gizli alanlari maskeler
 *  * derinligi sinirlar (dongusel yapi ve devasa govde koruması)
 *  * Date ve BigInt gibi tipleri serilestirilebilir hale getirir
 */
export function sanitizePayload(value: unknown, depth: number): unknown {
  if (depth > MAX_PAYLOAD_DEPTH) return '[derinlik sınırı]';
  if (value === null || value === undefined) return null;

  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value)) {
    const limited = value.slice(0, 100);
    const mapped: unknown[] = limited.map((item) => sanitizePayload(item, depth + 1));
    if (value.length > limited.length) {
      mapped.push(`[+${value.length - limited.length} kayıt daha]`);
    }
    return mapped;
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;

    if (typeof (source as { toJSON?: unknown }).toJSON === 'function') {
      return sanitizePayload((source as { toJSON: () => unknown }).toJSON(), depth + 1);
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      if (item === undefined) continue;
      result[key] = REDACTED_PAYLOAD_KEYS.has(key.toLowerCase())
        ? '[gizlendi]'
        : sanitizePayload(item, depth + 1);
    }
    return result;
  }

  if (typeof value === 'string') {
    return value.length > 2000 ? `${value.slice(0, 2000)}…[kısaltıldı]` : value;
  }

  if (typeof value === 'number' && !Number.isFinite(value)) return null;

  return value;
}
