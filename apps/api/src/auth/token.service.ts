/**
 * ToptanPortal - Jeton ve Oturum Servisi
 *
 * Jeton stratejisi:
 *  * Erisim jetonu (access): 15 dk omurlu, imzali JWT. Icinde rol ve oturum
 *    kimligi tasir; her istekte veritabani sorgusu gerektirmez.
 *  * Yenileme jetonu (refresh): 30 gun omurlu, OPAK rastgele deger. Veritabaninda
 *    yalnizca SHA-256 ozeti saklanir - veritabani sizsa bile jetonlar kullanilamaz.
 *  * Rotasyon: her yenilemede yeni jeton uretilir, eskisi iptal edilir.
 *  * Yeniden kullanim tespiti: iptal edilmis bir yenileme jetonu tekrar
 *    sunulursa, o giris zincirine (family) ait TUM oturumlar iptal edilir.
 *    Bu, calinmis jetonun kullanimini en fazla bir tur surdurur.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { ErrorCode, type UserRole } from '@toptanportal/contracts';
import { ClientPlatform, type Session } from '@toptanportal/db';

import type { AppConfig } from '../config/configuration';
import { CryptoService } from '../common/crypto/crypto.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ApiException } from '../common/exceptions/api.exception';
import { sessionRevokedKey } from '../common/guards/jwt-auth.guard';
import {
  TokenType,
  type AccessTokenPayload,
  type ChallengeTokenPayload,
} from '../common/types/jwt-payload';
import type { DeviceInfo } from '@toptanportal/contracts';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}

export interface SessionOwner {
  userId: string;
  tenantId: string;
  companyId: string | null;
  role: UserRole;
}

export interface CreateSessionOptions {
  owner: SessionOwner;
  device: DeviceInfo;
  ip: string;
  userAgent: string | null;
  familyId?: string;
  masqueradeCompanyId?: string | null;
  masqueradeReason?: string | null;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly config: AppConfig;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<AppConfig>('app');
  }

  // -------------------------------------------------------------------------
  // Oturum olusturma
  // -------------------------------------------------------------------------

  async createSession(options: CreateSessionOptions): Promise<IssuedTokens> {
    const refreshToken = this.crypto.generateToken(48);
    const refreshTokenHash = this.crypto.sha256(refreshToken);
    const deviceIdHash = this.crypto.sha256(options.device.deviceId);
    const familyId = options.familyId ?? randomUUID();

    const expiresAt = new Date(Date.now() + this.config.JWT_REFRESH_TTL * 1000);

    const session = await this.prisma.session.create({
      data: {
        userId: options.owner.userId,
        refreshTokenHash,
        familyId,
        deviceIdHash,
        deviceName: options.device.deviceName,
        platform: toPlatform(options.device.platform),
        appVersion: options.device.appVersion ?? null,
        ip: options.ip,
        userAgent: options.userAgent,
        expiresAt,
        masqueradeCompanyId: options.masqueradeCompanyId ?? null,
        masqueradeStartedAt: options.masqueradeCompanyId ? new Date() : null,
        masqueradeReason: options.masqueradeReason ?? null,
      },
    });

    const accessToken = await this.signAccessToken(session, options.owner);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.JWT_ACCESS_TTL,
      sessionId: session.id,
    };
  }

  private async signAccessToken(session: Session, owner: SessionOwner): Promise<string> {
    const payload: Omit<AccessTokenPayload, 'iat' | 'exp' | 'iss' | 'aud'> = {
      sub: owner.userId,
      tid: owner.tenantId,
      cid: owner.companyId,
      role: owner.role,
      sid: session.id,
      mid: session.masqueradeCompanyId,
      typ: TokenType.ACCESS,
      jti: randomUUID(),
    };

    return this.jwtService.signAsync(payload, {
      secret: this.config.JWT_ACCESS_SECRET,
      expiresIn: this.config.JWT_ACCESS_TTL,
      issuer: this.config.JWT_ISSUER,
      audience: this.config.JWT_AUDIENCE,
    });
  }

  // -------------------------------------------------------------------------
  // Yenileme (rotasyon + yeniden kullanim tespiti)
  // -------------------------------------------------------------------------

  async rotateSession(
    refreshToken: string,
    device: DeviceInfo,
    ip: string,
    userAgent: string | null,
  ): Promise<{ tokens: IssuedTokens; owner: SessionOwner; previousSessionId: string }> {
    const refreshTokenHash = this.crypto.sha256(refreshToken);

    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash },
      include: {
        user: {
          select: {
            id: true,
            tenantId: true,
            companyId: true,
            role: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!session) {
      throw ApiException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID);
    }

    // Iptal edilmis bir jetonun yeniden sunulmasi = calinma suphesi.
    if (session.revokedAt !== null) {
      this.logger.warn(
        `Yenileme jetonu yeniden kullanıldı (oturum ${session.id}, kullanıcı ${session.userId}). ` +
          `Zincirdeki tüm oturumlar iptal ediliyor.`,
      );
      await this.revokeFamily(session.familyId, 'Yenileme jetonu yeniden kullanıldı');
      throw ApiException.unauthorized(ErrorCode.REFRESH_TOKEN_REUSED);
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }

    if (session.user.deletedAt !== null || session.user.status !== 'ACTIVE') {
      throw ApiException.unauthorized(ErrorCode.SESSION_REVOKED);
    }

    // Jeton baska bir cihaza tasinmis olamaz.
    const deviceIdHash = this.crypto.sha256(device.deviceId);
    if (!this.crypto.safeEquals(session.deviceIdHash, deviceIdHash)) {
      await this.revokeFamily(session.familyId, 'Yenileme jetonu farklı cihazda kullanıldı');
      throw ApiException.unauthorized(ErrorCode.REFRESH_TOKEN_REUSED);
    }

    const owner: SessionOwner = {
      userId: session.user.id,
      tenantId: session.user.tenantId,
      companyId: session.user.companyId,
      role: session.user.role as UserRole,
    };

    const tokens = await this.createSession({
      owner,
      device,
      ip,
      userAgent,
      familyId: session.familyId,
      masqueradeCompanyId: session.masqueradeCompanyId,
      masqueradeReason: session.masqueradeReason,
    });

    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        revokedAt: new Date(),
        revokedReason: 'Rotasyon',
        replacedBySessionId: tokens.sessionId,
        lastUsedAt: new Date(),
      },
    });

    await this.markRevokedInCache(session.id);

    return { tokens, owner, previousSessionId: session.id };
  }

  // -------------------------------------------------------------------------
  // Iptal
  // -------------------------------------------------------------------------

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason.slice(0, 120) },
    });

    if (result.count > 0) {
      await this.markRevokedInCache(sessionId);
    }
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    const sessions = await this.prisma.session.findMany({
      where: { familyId, revokedAt: null },
      select: { id: true },
    });

    if (sessions.length === 0) return;

    await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason.slice(0, 120) },
    });

    await Promise.all(sessions.map((session) => this.markRevokedInCache(session.id)));
  }

  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    });

    if (sessions.length === 0) return 0;

    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason.slice(0, 120) },
    });

    await Promise.all(sessions.map((session) => this.markRevokedInCache(session.id)));
    return sessions.length;
  }

  /**
   * Iptal isaretcisini onbellege yazar. TTL erisim jetonunun azami omru
   * kadardir; bu sureden sonra jeton zaten kendiliginden gecersizdir.
   */
  private async markRevokedInCache(sessionId: string): Promise<void> {
    await this.redis.set(sessionRevokedKey(sessionId), '1', this.config.JWT_ACCESS_TTL + 60);
  }

  // -------------------------------------------------------------------------
  // Ara adim (challenge) jetonlari
  // -------------------------------------------------------------------------

  async signChallengeToken(
    userId: string,
    tenantId: string,
    type: ChallengeTokenPayload['typ'],
    deviceId: string,
  ): Promise<{ token: string; expiresIn: number }> {
    const payload: Omit<ChallengeTokenPayload, 'iat' | 'exp' | 'iss' | 'aud'> = {
      sub: userId,
      tid: tenantId,
      typ: type,
      did: this.crypto.sha256(deviceId),
      jti: randomUUID(),
    };

    const token = await this.jwtService.signAsync(payload, {
      secret: this.config.JWT_ACCESS_SECRET,
      expiresIn: this.config.JWT_MFA_CHALLENGE_TTL,
      issuer: this.config.JWT_ISSUER,
      audience: this.config.JWT_AUDIENCE,
    });

    return { token, expiresIn: this.config.JWT_MFA_CHALLENGE_TTL };
  }

  async verifyChallengeToken(
    token: string,
    expectedType: ChallengeTokenPayload['typ'],
  ): Promise<ChallengeTokenPayload> {
    let payload: ChallengeTokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<ChallengeTokenPayload>(token, {
        secret: this.config.JWT_ACCESS_SECRET,
        issuer: this.config.JWT_ISSUER,
        audience: this.config.JWT_AUDIENCE,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('expired')) {
        throw ApiException.unauthorized(ErrorCode.MFA_CHALLENGE_EXPIRED);
      }
      throw ApiException.unauthorized(ErrorCode.MFA_INVALID_CODE);
    }

    if (payload.typ !== expectedType) {
      throw ApiException.unauthorized(ErrorCode.MFA_INVALID_CODE);
    }

    // Tek kullanimlik: ayni challenge jetonu ikinci kez tuketilemez.
    const consumed = await this.redis.consumeOnce(
      `mfa:challenge:${payload.jti}`,
      this.config.JWT_MFA_CHALLENGE_TTL + 60,
    );

    if (!consumed) {
      throw ApiException.unauthorized(ErrorCode.MFA_CHALLENGE_EXPIRED);
    }

    return payload;
  }
}

function toPlatform(platform: DeviceInfo['platform']): ClientPlatform {
  switch (platform) {
    case 'IOS':
      return ClientPlatform.IOS;
    case 'ANDROID':
      return ClientPlatform.ANDROID;
    case 'WEB':
    default:
      return ClientPlatform.WEB;
  }
}
