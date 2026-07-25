/**
 * Yasal delil zinciri denetimi.
 *
 * Tum kiracilar icin audit_logs zincirini bastan sona dogrular:
 *  1) seq numaralari bosluksuz mu (silinmis kayit var mi)
 *  2) her kaydin prevHash'i bir onceki kaydin hash'ine esit mi
 *  3) her kaydin hash'i icerikten yeniden hesaplandiginda tutuyor mu
 *
 * Mahkemeye delil sunulmadan once ve gunluk cron ile calistirilmalidir.
 *   pnpm --filter @toptanportal/db verify-audit
 */

import { PrismaClient } from '@prisma/client';
import { AUDIT_GENESIS_HASH } from '@toptanportal/contracts';
import { computeAuditHash } from '../audit-hash';

const BATCH_SIZE = 1000;

interface TenantVerificationResult {
  tenantId: string;
  tenantCode: string;
  recordCount: number;
  problems: string[];
}

async function verifyTenant(
  prisma: PrismaClient,
  tenantId: string,
  tenantCode: string,
): Promise<TenantVerificationResult> {
  const problems: string[] = [];
  let expectedSeq = 1n;
  let expectedPrevHash = AUDIT_GENESIS_HASH;
  let cursorSeq = 0n;
  let recordCount = 0;

  for (;;) {
    const batch = await prisma.auditLog.findMany({
      where: { tenantId, seq: { gt: cursorSeq } },
      orderBy: { seq: 'asc' },
      take: BATCH_SIZE,
    });

    if (batch.length === 0) break;

    for (const record of batch) {
      recordCount += 1;

      if (record.seq !== expectedSeq) {
        problems.push(
          `Sira boslugu: ${expectedSeq} bekleniyordu, ${record.seq} bulundu. ` +
            `Aradaki kayitlar silinmis olabilir.`,
        );
        expectedSeq = record.seq;
      }

      if (record.prevHash !== expectedPrevHash) {
        problems.push(
          `Zincir kopukluğu (seq=${record.seq}): prevHash beklenen ` +
            `${expectedPrevHash.slice(0, 12)}... yerine ${record.prevHash.slice(0, 12)}...`,
        );
      }

      const recomputed = computeAuditHash(record.prevHash, {
        tenantId: record.tenantId,
        seq: record.seq,
        occurredAt: record.occurredAt,
        actorType: record.actorType,
        actorUserId: record.actorUserId,
        actorRole: record.actorRole,
        actorEmail: record.actorEmail,
        onBehalfOfCompanyId: record.onBehalfOfCompanyId,
        companyId: record.companyId,
        action: record.action,
        resourceType: record.resourceType,
        resourceId: record.resourceId,
        outcome: record.outcome,
        ip: record.ip,
        userAgent: record.userAgent,
        requestId: record.requestId,
        sessionId: record.sessionId,
        payload: record.payload,
      });

      if (recomputed !== record.hash) {
        problems.push(
          `İçerik değiştirilmiş (seq=${record.seq}, id=${record.id}): ` +
            `kayıtlı hash ${record.hash.slice(0, 12)}..., yeniden hesaplanan ${recomputed.slice(0, 12)}...`,
        );
      }

      expectedPrevHash = record.hash;
      expectedSeq = record.seq + 1n;
      cursorSeq = record.seq;
    }
  }

  const head = await prisma.auditChainHead.findUnique({ where: { tenantId } });
  if (head) {
    if (head.lastSeq !== cursorSeq) {
      problems.push(
        `Zincir başlığı tutarsız: head.lastSeq=${head.lastSeq}, son kayıt seq=${cursorSeq}.`,
      );
    }
    if (recordCount > 0 && head.lastHash !== expectedPrevHash) {
      problems.push('Zincir başlığındaki hash son kaydın hash değeriyle uyuşmuyor.');
    }
  } else if (recordCount > 0) {
    problems.push('Zincir başlığı (audit_chain_head) kaydı bulunamadı.');
  }

  return { tenantId, tenantCode, recordCount, problems };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let hasProblem = false;

  try {
    await prisma.$connect();
    const tenants = await prisma.tenant.findMany({
      select: { id: true, code: true },
      orderBy: { code: 'asc' },
    });

    if (tenants.length === 0) {
      process.stdout.write('Denetlenecek kiracı bulunamadı.\n');
      return;
    }

    for (const tenant of tenants) {
      const result = await verifyTenant(prisma, tenant.id, tenant.code);

      if (result.problems.length === 0) {
        process.stdout.write(
          `[BÜTÜN]  ${result.tenantCode}: ${result.recordCount} kayıt doğrulandı.\n`,
        );
        continue;
      }

      hasProblem = true;
      process.stderr.write(
        `[İHLAL]  ${result.tenantCode}: ${result.recordCount} kayıt, ${result.problems.length} sorun\n`,
      );
      for (const problem of result.problems) {
        process.stderr.write(`         - ${problem}\n`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  if (hasProblem) {
    process.stderr.write(
      '\nZincir bütünlüğü ihlal edilmiş. Bu kayıtlar delil niteliğini yitirmiş olabilir; ' +
        'derhal olay müdahale prosedürü başlatılmalıdır.\n',
    );
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nDenetim çalıştırılamadı: ${message}\n`);
  process.exitCode = 1;
});
