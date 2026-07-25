/**
 * ToptanPortal - Yasal Delil Zinciri Hash Hesabi
 *
 * Bu modul TEK dogruluk kaynagidir: kaydi yazan servis de, zinciri denetleyen
 * betik de ayni fonksiyonu kullanir. Aksi halde denetim yanlis alarm uretir.
 *
 * hash(n) = SHA256( prevHash(n) || "." || canonicalJson(kayit(n)) )
 *
 * Hash'e giren alan kumesi ASLA degistirilmemelidir; degistirilirse gecmis
 * zincir dogrulanamaz hale gelir. Yeni alan gerekiyorsa `payload` icine konur.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '@toptanportal/contracts';

export interface AuditHashInput {
  tenantId: string;
  seq: bigint;
  occurredAt: Date;
  actorType: string;
  actorUserId: string | null;
  actorRole: string | null;
  actorEmail: string | null;
  onBehalfOfCompanyId: string | null;
  companyId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  sessionId: string | null;
  payload: unknown;
}

/** Hash'e giren alanlari sabit sirada ve sabit bicimde toplar. */
export function buildAuditDigestPayload(input: AuditHashInput): Record<string, unknown> {
  return {
    action: input.action,
    actorEmail: input.actorEmail,
    actorRole: input.actorRole,
    actorType: input.actorType,
    actorUserId: input.actorUserId,
    companyId: input.companyId,
    ip: input.ip,
    occurredAt: input.occurredAt.toISOString(),
    onBehalfOfCompanyId: input.onBehalfOfCompanyId,
    outcome: input.outcome,
    payload: input.payload ?? {},
    requestId: input.requestId,
    resourceId: input.resourceId,
    resourceType: input.resourceType,
    seq: input.seq.toString(),
    sessionId: input.sessionId,
    tenantId: input.tenantId,
    userAgent: input.userAgent,
  };
}

export function computeAuditHash(prevHash: string, input: AuditHashInput): string {
  const body = canonicalJson(buildAuditDigestPayload(input));
  return createHash('sha256').update(`${prevHash}.${body}`, 'utf8').digest('hex');
}
