/**
 * ToptanPortal - IP Beyaz Liste Muhafizi
 *
 * GDD Bolum 2: "Super Admin ... Sadece beyaz listeye alinmis IP adreslerinden
 * erisim saglanabilir."
 *
 * Liste 60 saniye Redis'te onbelleklenir. Redis erisilemezse veritabanina
 * duser; her iki kaynak da okunamazsa ERISIM REDDEDILIR - yonetim paneli
 * icin acik devre davranis kabul edilemez.
 */

import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuditAction, ErrorCode, isIpWhitelistEnforced } from '@toptanportal/contracts';
import type { UserRole as PrismaUserRole } from '@toptanportal/db';

import type { AppConfig } from '../../config/configuration';
import { AuditService } from '../audit/audit.service';
import { getRequestContext } from '../context/request-context';
import { IS_PUBLIC_KEY } from '../decorators';
import { ApiException } from '../exceptions/api.exception';
import { isIpAllowed } from '../net/ip.util';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const CACHE_TTL_SECONDS = 60;
const cacheKey = (tenantId: string): string => `ipwhitelist:${tenantId}`;

@Injectable()
export class IpWhitelistGuard implements CanActivate {
  private readonly logger = new Logger(IpWhitelistGuard.name);
  private readonly enforced: boolean;

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    const config = configService.getOrThrow<AppConfig>('app');
    this.enforced = config.SUPER_ADMIN_IP_WHITELIST_ENFORCED;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requestContext = getRequestContext();
    const principal = requestContext?.principal;

    if (!principal) return true; // Kimlik muhafizi zaten reddetmis olacak.
    if (!isIpWhitelistEnforced(principal.role)) return true;
    if (!this.enforced) {
      this.logger.warn(
        'Süper Admin IP beyaz listesi devre dışı. Bu ayar yalnızca geliştirme ortamında kabul edilebilir.',
      );
      return true;
    }

    const allowedCidrs = await this.loadWhitelist(principal.tenantId);
    const clientIp = requestContext.ip;

    if (allowedCidrs.length > 0 && isIpAllowed(clientIp, allowedCidrs)) {
      return true;
    }

    await this.auditService.recordSafely({
      tenantId: principal.tenantId,
      action: AuditAction.AUTH_IP_REJECTED,
      outcome: 'DENIED',
      resourceType: 'endpoint',
      resourceId: `${requestContext.method} ${requestContext.path}`,
      actorRole: principal.role as PrismaUserRole,
      payload: {
        clientIp,
        whitelistSize: allowedCidrs.length,
        country: requestContext.country,
        city: requestContext.city,
      },
    });

    throw ApiException.forbidden(ErrorCode.IP_NOT_WHITELISTED);
  }

  private async loadWhitelist(tenantId: string): Promise<string[]> {
    const key = cacheKey(tenantId);
    const cached = await this.redis.get(key);

    if (cached) {
      try {
        const parsed = JSON.parse(cached) as unknown;
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
          return parsed;
        }
      } catch {
        await this.redis.delete(key);
      }
    }

    const now = new Date();
    const rows = await this.prisma.adminIpWhitelist.findMany({
      where: {
        tenantId,
        isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { cidr: true },
    });

    const cidrs = rows.map((row) => row.cidr);
    await this.redis.set(key, JSON.stringify(cidrs), CACHE_TTL_SECONDS);
    return cidrs;
  }
}

/** Beyaz liste degistiginde onbellegi gecersiz kilmak icin. */
export function ipWhitelistCacheKey(tenantId: string): string {
  return cacheKey(tenantId);
}
