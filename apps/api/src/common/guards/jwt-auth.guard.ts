/**
 * ToptanPortal - Kimlik Dogrulama Muhafizi
 *
 * Sirasiyla:
 *  1. @Public isaretli uc noktalari gecirir
 *  2. Bearer jetonunu dogrular (imza, issuer, audience, tur)
 *  3. Oturumun iptal edilmedigini denetler (Redis isaretci + veritabani yedegi)
 *  4. Kullanicinin hala aktif oldugunu denetler (60 sn onbellekli anlik goruntu)
 *  5. Baglami (RequestContext) doldurur
 *
 * Erisim jetonlari 15 dakikalik oldugundan iptal isaretcileri kisa omurludur;
 * bu, her istekte veritabanina gitmeden hem hizli hem dogru calismayi saglar.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  ErrorCode,
  getPermissionsForRole,
  isBlindOrderRole,
  isUserRole,
  type UserRole,
} from '@toptanportal/contracts';
import { UserStatus } from '@toptanportal/db';

import type { AppConfig } from '../../config/configuration';
import { IS_PUBLIC_KEY } from '../decorators';
import { ApiException } from '../exceptions/api.exception';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { setPrincipal } from '../context/request-context';
import { TokenType, type AccessTokenPayload } from '../types/jwt-payload';

/** Oturum iptal isaretcisi: bu anahtar varsa jeton gecersizdir. */
export const sessionRevokedKey = (sessionId: string): string =>
  `sess:revoked:${sessionId}`;

/** Kullanici anlik goruntusu onbellegi. */
const userSnapshotKey = (userId: string): string => `user:snapshot:${userId}`;
const USER_SNAPSHOT_TTL_SECONDS = 60;

interface UserSnapshot {
  status: UserStatus;
  role: string;
  email: string;
  fullName: string;
  companyId: string | null;
  tenantId: string;
  passwordChangedAt: number;
  deleted: boolean;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    const config = configService.getOrThrow<AppConfig>('app');
    this.issuer = config.JWT_ISSUER;
    this.audience = config.JWT_AUDIENCE;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearerToken(request.header('authorization'));

    if (!token) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }

    const payload = await this.verifyToken(token);
    await this.assertSessionActive(payload.sid);
    const snapshot = await this.loadUserSnapshot(payload.sub);

    if (!snapshot || snapshot.deleted) {
      throw ApiException.unauthorized(ErrorCode.SESSION_REVOKED);
    }

    if (snapshot.status === UserStatus.SUSPENDED) {
      throw ApiException.forbidden(ErrorCode.ACCOUNT_SUSPENDED);
    }

    if (snapshot.status === UserStatus.LOCKED) {
      throw ApiException.forbidden(ErrorCode.ACCOUNT_LOCKED);
    }

    if (snapshot.status !== UserStatus.ACTIVE) {
      throw ApiException.forbidden(ErrorCode.ACCOUNT_INVITED_NOT_ACTIVE);
    }

    // Rol veya kiraci degistiyse eski jeton derhal gecersizdir.
    if (snapshot.tenantId !== payload.tid || snapshot.role !== payload.role) {
      throw ApiException.unauthorized(ErrorCode.SESSION_REVOKED);
    }

    // Sifre degistiyse, degisiklikten once uretilmis jetonlar gecersizdir.
    if (payload.iat * 1000 < snapshot.passwordChangedAt) {
      throw ApiException.unauthorized(ErrorCode.SESSION_REVOKED);
    }

    if (!isUserRole(snapshot.role)) {
      this.logger.error(`Tanımsız rol değeri: ${snapshot.role} (kullanıcı ${payload.sub})`);
      throw ApiException.forbidden(ErrorCode.FORBIDDEN);
    }

    const role: UserRole = snapshot.role;

    setPrincipal({
      userId: payload.sub,
      tenantId: payload.tid,
      companyId: snapshot.companyId,
      email: snapshot.email,
      fullName: snapshot.fullName,
      role,
      permissions: getPermissionsForRole(role),
      sessionId: payload.sid,
      blindOrderMode: isBlindOrderRole(role),
      masqueradeCompanyId: payload.mid,
    });

    return true;
  }

  private async verifyToken(token: string): Promise<AccessTokenPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        issuer: this.issuer,
        audience: this.audience,
      });

      if (payload.typ !== TokenType.ACCESS) {
        throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
      }

      return payload;
    } catch (error) {
      if (error instanceof ApiException) throw error;

      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('expired')) {
        throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
      }
      throw ApiException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID);
    }
  }

  /**
   * Oturumun iptal edilip edilmedigini denetler.
   * Redis saglikliysa O(1) isaretci kontrolu yeterlidir; degilse veritabanina
   * duserek dogru karari verir - erisilebilirlik ugruna iptal edilmis bir
   * oturumun gecmesine izin verilmez.
   */
  private async assertSessionActive(sessionId: string): Promise<void> {
    if (this.redis.healthy) {
      const revoked = await this.redis.exists(sessionRevokedKey(sessionId));
      if (revoked) {
        throw ApiException.unauthorized(ErrorCode.SESSION_REVOKED);
      }
      return;
    }

    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { revokedAt: true, expiresAt: true },
    });

    if (!session || session.revokedAt !== null) {
      throw ApiException.unauthorized(ErrorCode.SESSION_REVOKED);
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }
  }

  private async loadUserSnapshot(userId: string): Promise<UserSnapshot | null> {
    const cacheKey = userSnapshotKey(userId);
    const cached = await this.redis.get(cacheKey);

    if (cached) {
      try {
        return JSON.parse(cached) as UserSnapshot;
      } catch {
        await this.redis.delete(cacheKey);
      }
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        role: true,
        email: true,
        fullName: true,
        companyId: true,
        tenantId: true,
        passwordChangedAt: true,
        deletedAt: true,
      },
    });

    if (!user) return null;

    const snapshot: UserSnapshot = {
      status: user.status,
      role: user.role,
      email: user.email,
      fullName: user.fullName,
      companyId: user.companyId,
      tenantId: user.tenantId,
      passwordChangedAt: user.passwordChangedAt.getTime(),
      deleted: user.deletedAt !== null,
    };

    await this.redis.set(cacheKey, JSON.stringify(snapshot), USER_SNAPSHOT_TTL_SECONDS);
    return snapshot;
  }
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;

  const [scheme, value] = header.split(' ');
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;

  const token = value.trim();
  return token.length > 0 ? token : null;
}

/** Kullanici anlik goruntusunu gecersiz kilar (rol/durum/sifre degisikliginde). */
export function userSnapshotCacheKey(userId: string): string {
  return userSnapshotKey(userId);
}
