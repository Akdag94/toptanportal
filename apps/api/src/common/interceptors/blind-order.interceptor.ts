/**
 * ToptanPortal - Kor Siparis Modu Suzgeci (Blind Order Interceptor)
 *
 * GDD Bolum 2 - Kritik Guvenlik Modulu:
 * "Isletme Alt Yetkilisi hesabi ile giris yapildiginda UI layer ve API
 *  yanitlarindaki tum price, discount, balance, tax nesneleri middleware
 *  tarafindan sifirlanir/gizlenir. Ekranda sadece urun adi, gorseli, birimi
 *  ve stok durumu gosterilir."
 *
 * TASARIM KARARLARI
 * -----------------
 * 1. Alanlar MASKELENMEZ, SILINIR. "0.00" veya "***" yazmak alanin varligini
 *    ve veri modelini sizdirir; ayrica istemcide yanlislikla render edilme
 *    riski dogurur. Silme, sizinti yuzeyini sifirlar.
 *
 * 2. Suzgec SON SAVUNMA HATTIDIR, tek savunma degil. Servis katmani zaten
 *    yetkisiz alanlari sorgulamamalidir. Bu katman, gelecekteki bir
 *    gelistiricinin unutmasi durumunda devreye giren guvenlik agidir.
 *
 * 3. Yanit akis (stream) veya ikili (buffer) ise dokunulmaz - bu tur yanitlar
 *    zaten yetki muhafizindan gecmis dosya indirmeleridir ve Kor Sipariş
 *    rolunun bu uc noktalara erisimi yoktur.
 *
 * 4. Suzgecin bir sey sildigi ilk olay yasal delil loguna islenir; ayni oturum
 *    ve uc nokta icin saatte bir kez tekrarlanir (log tasmasini onlemek icin).
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { AuditAction, isBlindOrderStrippedField } from '@toptanportal/contracts';
import type { UserRole as PrismaUserRole } from '@toptanportal/db';

import { AuditService } from '../audit/audit.service';
import { getRequestContext } from '../context/request-context';
import { BLIND_ORDER_EXEMPT_KEY } from '../decorators';
import { RedisService } from '../redis/redis.service';

const MAX_DEPTH = 12;
const AUDIT_THROTTLE_SECONDS = 3600;

export interface StripResult {
  value: unknown;
  strippedFields: string[];
}

@Injectable()
export class BlindOrderInterceptor implements NestInterceptor {
  private readonly logger = new Logger(BlindOrderInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
    private readonly redis: RedisService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const requestContext = getRequestContext();
    const principal = requestContext?.principal;

    if (!principal?.blindOrderMode) {
      return next.handle();
    }

    const exempt = this.reflector.getAllAndOverride<boolean>(BLIND_ORDER_EXEMPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (exempt) {
      this.logger.warn(
        `Kör Sipariş süzgeci muafiyeti kullanıldı: ` +
          `${context.getClass().name}.${context.getHandler().name} ` +
          `(kullanıcı ${principal.userId})`,
      );
      return next.handle();
    }

    const endpoint = `${context.getClass().name}.${context.getHandler().name}`;

    return next.handle().pipe(
      map((payload: unknown) => {
        const result = stripFinancialFields(payload, 0, new WeakSet());

        if (result.strippedFields.length > 0) {
          void this.auditStripping(endpoint, result.strippedFields, principal);
        }

        return annotateBlindMode(result.value);
      }),
    );
  }

  private async auditStripping(
    endpoint: string,
    strippedFields: readonly string[],
    principal: NonNullable<ReturnType<typeof getRequestContext>>['principal'],
  ): Promise<void> {
    if (!principal) return;

    const throttleKey = `blindorder:audited:${principal.sessionId}:${endpoint}`;
    const shouldRecord = await this.redis.consumeOnce(throttleKey, AUDIT_THROTTLE_SECONDS);
    if (!shouldRecord) return;

    await this.auditService.recordSafely({
      tenantId: principal.tenantId,
      action: AuditAction.BLIND_ORDER_APPLIED,
      resourceType: 'endpoint',
      resourceId: endpoint,
      actorRole: principal.role as PrismaUserRole,
      payload: {
        strippedFieldCount: strippedFields.length,
        strippedFields: [...new Set(strippedFields)].sort(),
      },
    });
  }
}

/**
 * Yanit govdesinden finansal alanlari ozyinelemeli olarak temizler.
 * Girdi nesnesi DEGISTIRILMEZ; yeni bir yapi uretilir.
 */
export function stripFinancialFields(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): StripResult {
  if (value === null || value === undefined) {
    return { value: value ?? null, strippedFields: [] };
  }

  if (depth > MAX_DEPTH) {
    return { value, strippedFields: [] };
  }

  const primitiveOrOpaque =
    typeof value !== 'object' ||
    value instanceof Date ||
    Buffer.isBuffer(value) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value);

  if (primitiveOrOpaque) {
    return { value, strippedFields: [] };
  }

  // Dongusel referans: ayni nesneye ikinci kez girme.
  if (seen.has(value as object)) {
    return { value, strippedFields: [] };
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    const stripped: string[] = [];
    const mapped = value.map((item) => {
      const result = stripFinancialFields(item, depth + 1, seen);
      stripped.push(...result.strippedFields);
      return result.value;
    });
    return { value: mapped, strippedFields: stripped };
  }

  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const stripped: string[] = [];

  for (const [key, item] of Object.entries(source)) {
    if (isBlindOrderStrippedField(key)) {
      stripped.push(key);
      continue;
    }

    const result = stripFinancialFields(item, depth + 1, seen);
    stripped.push(...result.strippedFields);
    output[key] = result.value;
  }

  return { value: output, strippedFields: stripped };
}

/**
 * Istemciye modun etkin oldugunu bildirir. iOS ve Web arayuzleri bu bayragi
 * gorunce fiyat sutunlarini hic olusturmaz.
 */
function annotateBlindMode(value: unknown): unknown {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Date ||
    Buffer.isBuffer(value)
  ) {
    return value;
  }

  return { ...(value as Record<string, unknown>), blindOrderMode: true };
}
