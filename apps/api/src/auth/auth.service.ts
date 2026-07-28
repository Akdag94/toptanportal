/**
 * ToptanPortal - Kimlik Dogrulama Servisi
 *
 * GIRIS AKISI
 * -----------
 *   e-posta + sifre
 *        |
 *        +-- hesap kilitli / askida  -> reddet (denemeyi logla)
 *        +-- sifre hatali            -> sayaci artir, esik asilirsa kilitle
 *        |
 *        v
 *   SUPER_ADMIN ise IP beyaz listesi denetimi (giriste, jeton uretmeden once)
 *        |
 *        v
 *   +-- zorunlu sifre degisikligi? -> PASSWORD_CHANGE_REQUIRED
 *   +-- 2FA zorunlu, kayit yok?    -> MFA_ENROLLMENT_REQUIRED
 *   +-- 2FA kayitli, cihaz guvenilir degil? -> MFA_REQUIRED
 *   +-- aksi halde                 -> SUCCESS (oturum acilir)
 *
 * Her adim yasal delil loguna islenir (5651 / 5070).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  ErrorCode,
  LoginOutcome,
  NotificationTopic,
  ROLE_LABELS,
  ROLE_PRIMARY_PLATFORM,
  getPermissionsForRole,
  isBlindOrderRole,
  isIpWhitelistEnforced,
  isMfaMandatory,
  type ChangePasswordRequest,
  type DeviceInfo,
  type LoginRequest,
  type LoginResponse,
  type MfaEnrollConfirmResponse,
  type MfaEnrollStartResponse,
  type MfaVerifyRequest,
  type SessionUser,
  type StartMasqueradeRequest,
  type TokenPair,
  type UserRole,
} from '@toptanportal/contracts';
import {
  LoginFailureReason,
  MfaMethod,
  UserStatus,
  type Company,
  type User,
} from '@toptanportal/db';

import type { AppConfig } from '../config/configuration';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { NotificationService } from '../notification/notification.service';
import { ApiException } from '../common/exceptions/api.exception';
import { getRequestContext } from '../common/context/request-context';
import { isIpAllowed } from '../common/net/ip.util';
import { userSnapshotCacheKey } from '../common/guards/jwt-auth.guard';
import { TokenType } from '../common/types/jwt-payload';
import { TokenService, type SessionOwner } from './token.service';
import { TotpService } from './totp.service';

const TRUSTED_DEVICE_DAYS = 30;
const RECOVERY_CODE_COUNT = 10;
const ENROLLMENT_SECRET_TTL_SECONDS = 600;

const enrollmentSecretKey = (userId: string): string => `mfa:enroll:secret:${userId}`;

type UserWithCompany = User & { company: Company | null };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly config: AppConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly tokenService: TokenService,
    private readonly totpService: TotpService,
    private readonly auditService: AuditService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<AppConfig>('app');
  }

  // =========================================================================
  // Giris
  // =========================================================================

  async login(dto: LoginRequest, tenantCode: string | null): Promise<LoginResponse> {
    // Baglamin varligini bastan dogrula: IP ve requestId olmadan yasal delil
    // kaydi eksik kalir, bu da girisin hic yapilmamasindan daha kotudur.
    this.requireContext();
    const emailNormalized = dto.email.trim().toLowerCase();

    const user = await this.resolveUser(emailNormalized, tenantCode);

    if (!user) {
      // Kullanici yoksa da Argon2 maliyetini ode: zamanlama farkindan
      // gecerli e-posta adresleri kesfedilemesin.
      await this.crypto.burnPasswordVerification();
      await this.recordLoginAttempt({
        tenantId: null,
        emailNormalized,
        userId: null,
        success: false,
        failureReason: LoginFailureReason.UNKNOWN_EMAIL,
      });
      throw ApiException.unauthorized(ErrorCode.INVALID_CREDENTIALS);
    }

    await this.assertAccountUsable(user, emailNormalized);

    const passwordValid = await this.crypto.verifyPassword(user.passwordHash, dto.password);

    if (!passwordValid) {
      await this.registerFailedAttempt(user, emailNormalized);
      throw ApiException.unauthorized(ErrorCode.INVALID_CREDENTIALS);
    }

    // Yonetim rolu icin IP denetimi jeton uretilmeden once yapilir.
    await this.assertIpAllowedForRole(user, emailNormalized);

    await this.resetFailureCounters(user.id);
    await this.recordLoginAttempt({
      tenantId: user.tenantId,
      emailNormalized,
      userId: user.id,
      success: true,
      failureReason: null,
    });

    if (user.mustChangePassword) {
      const challenge = await this.tokenService.signChallengeToken(
        user.id,
        user.tenantId,
        TokenType.PASSWORD_CHANGE,
        dto.device.deviceId,
      );

      await this.auditService.recordSafely({
        tenantId: user.tenantId,
        action: AuditAction.AUTH_LOGIN_SUCCESS,
        actorUserId: user.id,
        actorRole: user.role,
        actorEmail: user.email,
        companyId: user.companyId,
        payload: { stage: 'PASSWORD_CHANGE_REQUIRED', platform: dto.device.platform },
      });

      return {
        outcome: LoginOutcome.PASSWORD_CHANGE_REQUIRED,
        challengeToken: challenge.token,
        expiresIn: challenge.expiresIn,
      };
    }

    const mfaRequired = user.mfaRequired || isMfaMandatory(user.role as UserRole);
    const mfaEnrolled = user.mfaSecretEnc !== null && user.mfaEnrolledAt !== null;

    if (mfaRequired && !mfaEnrolled) {
      const challenge = await this.tokenService.signChallengeToken(
        user.id,
        user.tenantId,
        TokenType.MFA_ENROLLMENT,
        dto.device.deviceId,
      );

      await this.auditService.recordSafely({
        tenantId: user.tenantId,
        action: AuditAction.AUTH_MFA_CHALLENGED,
        actorUserId: user.id,
        actorRole: user.role,
        actorEmail: user.email,
        companyId: user.companyId,
        payload: { stage: 'ENROLLMENT_REQUIRED', platform: dto.device.platform },
      });

      return {
        outcome: LoginOutcome.MFA_ENROLLMENT_REQUIRED,
        challengeToken: challenge.token,
        expiresIn: challenge.expiresIn,
      };
    }

    if (mfaEnrolled && !(await this.isTrustedDevice(user.id, dto.device.deviceId))) {
      const challenge = await this.tokenService.signChallengeToken(
        user.id,
        user.tenantId,
        TokenType.MFA_CHALLENGE,
        dto.device.deviceId,
      );

      await this.auditService.recordSafely({
        tenantId: user.tenantId,
        action: AuditAction.AUTH_MFA_CHALLENGED,
        actorUserId: user.id,
        actorRole: user.role,
        actorEmail: user.email,
        companyId: user.companyId,
        payload: { stage: 'CODE_REQUIRED', platform: dto.device.platform },
      });

      return {
        outcome: LoginOutcome.MFA_REQUIRED,
        challengeToken: challenge.token,
        method: user.mfaMethod === MfaMethod.SMS ? 'SMS' : 'TOTP',
        maskedPhone: this.maskPhone(user),
        expiresIn: challenge.expiresIn,
      };
    }

    const issued = await this.completeLogin(user, dto.device, {
      mfaUsed: mfaEnrolled ? 'TRUSTED_DEVICE' : 'NONE',
    });

    return { outcome: LoginOutcome.SUCCESS, tokens: issued.tokens, user: issued.user };
  }

  // =========================================================================
  // 2FA dogrulamasi
  // =========================================================================

  async verifyMfa(dto: MfaVerifyRequest, device: DeviceInfo): Promise<LoginResponse> {
    const payload = await this.tokenService.verifyChallengeToken(
      dto.challengeToken,
      TokenType.MFA_CHALLENGE,
    );

    if (!this.crypto.safeEquals(payload.did, this.crypto.sha256(device.deviceId))) {
      throw ApiException.unauthorized(ErrorCode.MFA_INVALID_CODE);
    }

    const user = await this.loadUserWithCompany(payload.sub);

    if (!user || !user.mfaSecretEnc) {
      throw ApiException.unauthorized(ErrorCode.MFA_NOT_ENROLLED);
    }

    await this.assertAccountUsable(user, user.emailNormalized);

    const code = dto.code.trim();
    const isRecoveryCode = code.includes('-') || code.length > 6;

    const verified = isRecoveryCode
      ? await this.consumeRecoveryCode(user.id, code)
      : await this.totpService.verifyCode(user.id, user.mfaSecretEnc, code);

    if (!verified) {
      await this.registerFailedAttempt(user, user.emailNormalized, LoginFailureReason.MFA_FAILED);
      await this.auditService.recordSafely({
        tenantId: user.tenantId,
        action: AuditAction.AUTH_MFA_FAILED,
        outcome: 'FAILURE',
        actorUserId: user.id,
        actorRole: user.role,
        actorEmail: user.email,
        companyId: user.companyId,
        payload: { method: isRecoveryCode ? 'RECOVERY_CODE' : 'TOTP' },
      });
      throw ApiException.unauthorized(ErrorCode.MFA_INVALID_CODE);
    }

    await this.resetFailureCounters(user.id);

    if (dto.trustDevice) {
      await this.rememberDevice(user.id, device);
    }

    await this.auditService.recordSafely({
      tenantId: user.tenantId,
      action: isRecoveryCode
        ? AuditAction.AUTH_RECOVERY_CODE_USED
        : AuditAction.AUTH_MFA_SUCCESS,
      actorUserId: user.id,
      actorRole: user.role,
      actorEmail: user.email,
      companyId: user.companyId,
      payload: { trustDevice: dto.trustDevice, deviceName: device.deviceName },
    });

    const issued = await this.completeLogin(user, device, {
      mfaUsed: isRecoveryCode ? 'RECOVERY_CODE' : 'TOTP',
    });

    return { outcome: LoginOutcome.SUCCESS, tokens: issued.tokens, user: issued.user };
  }

  // =========================================================================
  // Zorunlu 2FA kaydi
  // =========================================================================

  async startMandatoryEnrollment(challengeToken: string): Promise<MfaEnrollStartResponse> {
    const payload = await this.tokenService.verifyChallengeToken(
      challengeToken,
      TokenType.MFA_ENROLLMENT,
    );

    const user = await this.loadUserWithCompany(payload.sub);
    if (!user) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }

    if (user.mfaSecretEnc !== null && user.mfaEnrolledAt !== null) {
      throw ApiException.conflict(ErrorCode.MFA_ALREADY_ENROLLED);
    }

    return this.prepareEnrollment(user, payload.did);
  }

  /** Oturum acmis kullanicinin gonullu 2FA kaydini baslatir. */
  async startVoluntaryEnrollment(
    userId: string,
    device: DeviceInfo,
  ): Promise<MfaEnrollStartResponse> {
    const user = await this.loadUserWithCompany(userId);
    if (!user) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }

    if (user.mfaSecretEnc !== null && user.mfaEnrolledAt !== null) {
      throw ApiException.conflict(ErrorCode.MFA_ALREADY_ENROLLED);
    }

    return this.prepareEnrollment(user, this.crypto.sha256(device.deviceId));
  }

  private async prepareEnrollment(
    user: UserWithCompany,
    deviceIdHash: string,
  ): Promise<MfaEnrollStartResponse> {
    const enrollment = await this.totpService.createEnrollment(user.email);

    await this.redis.set(
      enrollmentSecretKey(user.id),
      enrollment.secret,
      ENROLLMENT_SECRET_TTL_SECONDS,
    );

    const token = await this.tokenService.signChallengeToken(
      user.id,
      user.tenantId,
      TokenType.MFA_ENROLLMENT,
      deviceIdHash,
    );

    return {
      secret: enrollment.secret,
      otpauthUri: enrollment.otpauthUri,
      qrCodeDataUrl: enrollment.qrCodeDataUrl,
      enrollmentToken: token.token,
      expiresIn: token.expiresIn,
    };
  }

  async confirmMandatoryEnrollment(
    enrollmentToken: string,
    code: string,
    device: DeviceInfo,
  ): Promise<MfaEnrollConfirmResponse> {
    const payload = await this.tokenService.verifyChallengeToken(
      enrollmentToken,
      TokenType.MFA_ENROLLMENT,
    );

    const user = await this.loadUserWithCompany(payload.sub);
    if (!user) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }

    await this.assertAccountUsable(user, user.emailNormalized);

    const recoveryCodes = await this.persistEnrollment(user, code);
    const issued = await this.completeLogin(user, device, { mfaUsed: 'ENROLLMENT' });

    return { recoveryCodes, tokens: issued.tokens, user: issued.user };
  }

  async confirmVoluntaryEnrollment(userId: string, code: string): Promise<string[]> {
    const user = await this.loadUserWithCompany(userId);
    if (!user) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }

    return this.persistEnrollment(user, code);
  }

  /**
   * Secret'i kalici hale getirir ve kurtarma kodlarini uretir.
   * Kodlar yalnizca bu cagrida duz metin olarak doner; veritabaninda Argon2id
   * ozeti tutulur.
   */
  private async persistEnrollment(user: UserWithCompany, code: string): Promise<string[]> {
    const secret = await this.redis.get(enrollmentSecretKey(user.id));

    if (!secret) {
      throw ApiException.unauthorized(ErrorCode.MFA_CHALLENGE_EXPIRED);
    }

    if (!this.totpService.verifyPlainSecret(secret, code)) {
      await this.auditService.recordSafely({
        tenantId: user.tenantId,
        action: AuditAction.AUTH_MFA_FAILED,
        outcome: 'FAILURE',
        actorUserId: user.id,
        actorRole: user.role,
        actorEmail: user.email,
        companyId: user.companyId,
        payload: { stage: 'ENROLLMENT' },
      });
      throw ApiException.unauthorized(ErrorCode.MFA_INVALID_CODE);
    }

    const plainCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      this.crypto.generateRecoveryCode(),
    );
    const hashedCodes = await Promise.all(
      plainCodes.map(async (plain) => ({
        userId: user.id,
        codeHash: await this.crypto.hashPassword(plain),
      })),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          mfaSecretEnc: this.totpService.encryptSecret(secret),
          mfaMethod: MfaMethod.TOTP,
          mfaEnrolledAt: new Date(),
          mfaRequired: true,
        },
      });

      await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.mfaRecoveryCode.createMany({ data: hashedCodes });

      await this.auditService.record(
        {
          tenantId: user.tenantId,
          action: AuditAction.AUTH_MFA_ENROLLED,
          actorUserId: user.id,
          actorRole: user.role,
          actorEmail: user.email,
          companyId: user.companyId,
          resourceType: 'user',
          resourceId: user.id,
          payload: { method: 'TOTP', recoveryCodeCount: plainCodes.length },
        },
        tx,
      );
    });

    await this.redis.delete(enrollmentSecretKey(user.id));
    await this.invalidateUserSnapshot(user.id);

    return plainCodes;
  }

  // =========================================================================
  // Oturum yenileme / kapatma
  // =========================================================================

  async refresh(
    refreshToken: string,
    device: DeviceInfo,
  ): Promise<{ tokens: TokenPair; user: SessionUser }> {
    const context = this.requireContext();

    const rotated = await this.tokenService.rotateSession(
      refreshToken,
      device,
      context.ip,
      context.userAgent,
    );

    const user = await this.loadUserWithCompany(rotated.owner.userId);
    if (!user) {
      throw ApiException.unauthorized(ErrorCode.SESSION_REVOKED);
    }

    const session = await this.prisma.session.findUnique({
      where: { id: rotated.tokens.sessionId },
      select: { masqueradeCompanyId: true, masqueradeStartedAt: true },
    });

    await this.auditService.recordSafely({
      tenantId: user.tenantId,
      action: AuditAction.AUTH_TOKEN_REFRESHED,
      actorUserId: user.id,
      actorRole: user.role,
      actorEmail: user.email,
      companyId: user.companyId,
      resourceType: 'session',
      resourceId: rotated.tokens.sessionId,
      payload: { previousSessionId: rotated.previousSessionId },
    });

    return {
      tokens: this.toTokenPair(rotated.tokens),
      user: await this.buildSessionUser(
        user,
        session?.masqueradeCompanyId ?? null,
        session?.masqueradeStartedAt ?? null,
      ),
    };
  }

  async logout(
    userId: string,
    tenantId: string,
    sessionId: string,
    allDevices: boolean,
  ): Promise<{ revokedSessions: number }> {
    const revoked = allDevices
      ? await this.tokenService.revokeAllForUser(userId, 'Kullanıcı çıkışı (tüm cihazlar)')
      : await this.revokeSingle(sessionId);

    await this.auditService.recordSafely({
      tenantId,
      action: AuditAction.AUTH_LOGOUT,
      actorUserId: userId,
      resourceType: 'session',
      resourceId: sessionId,
      payload: { allDevices, revokedSessions: revoked },
    });

    return { revokedSessions: revoked };
  }

  private async revokeSingle(sessionId: string): Promise<number> {
    await this.tokenService.revokeSession(sessionId, 'Kullanıcı çıkışı');
    return 1;
  }

  // =========================================================================
  // Sifre degistirme
  // =========================================================================

  async changePassword(
    userId: string,
    tenantId: string,
    dto: ChangePasswordRequest,
    currentSessionId: string | null,
  ): Promise<{ revokedSessions: number }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }

    const valid = await this.crypto.verifyPassword(user.passwordHash, dto.currentPassword);
    if (!valid) {
      await this.auditService.recordSafely({
        tenantId,
        action: AuditAction.AUTH_PASSWORD_CHANGED,
        outcome: 'FAILURE',
        actorUserId: userId,
        resourceType: 'user',
        resourceId: userId,
        payload: { reason: 'Mevcut şifre hatalı' },
      });
      throw ApiException.unauthorized(ErrorCode.INVALID_CREDENTIALS);
    }

    const passwordHash = await this.crypto.hashPassword(dto.newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          mustChangePassword: false,
        },
      });

      await this.auditService.record(
        {
          tenantId,
          action: AuditAction.AUTH_PASSWORD_CHANGED,
          actorUserId: userId,
          actorRole: user.role,
          actorEmail: user.email,
          companyId: user.companyId,
          resourceType: 'user',
          resourceId: userId,
          payload: { forced: user.mustChangePassword },
        },
        tx,
      );

      /* Sifre degisikligi bildirimi, hesabi ele gecirilen kullanicinin
         durumu ogrenmesinin TEK yoludur: saldirganin ilk isi sifreyi
         degistirmek ve oturumlari kapatmaktir. Bu yuzden konu kapatilamaz
         (MANDATORY_TOPICS) ve kayit sifre degisikligiyle ayni islemde
         yazilir - islem geri alinirsa bildirim de olusmaz. */
      await this.notifications.enqueue(
        {
          tenantId,
          payload: {
            topic: NotificationTopic.SECURITY,
            eventLabel: 'Şifre değiştirildi',
            occurredAt: new Date().toISOString(),
          },
          recipientUserIds: [userId],
          dedupeKey: `security:${userId}:password:${Date.now()}`,
        },
        tx,
      );
    });

    await this.invalidateUserSnapshot(userId);

    // Sifre degistiginde diger tum oturumlar kapatilir.
    const revoked = await this.tokenService.revokeAllForUser(userId, 'Şifre değiştirildi');
    void currentSessionId;

    return { revokedSessions: revoked };
  }

  /**
   * Zorunlu sifre degisikligini tamamlar ve oturumu acar.
   * Kullanici bu adimi gecmeden hicbir uc noktaya erisemez.
   */
  async completeForcedPasswordChange(
    challengeToken: string,
    newPassword: string,
    device: DeviceInfo,
  ): Promise<LoginResponse> {
    const payload = await this.tokenService.verifyChallengeToken(
      challengeToken,
      TokenType.PASSWORD_CHANGE,
    );

    if (!this.crypto.safeEquals(payload.did, this.crypto.sha256(device.deviceId))) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }

    const user = await this.loadUserWithCompany(payload.sub);
    if (!user) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }

    await this.assertAccountUsable(user, user.emailNormalized);

    const sameAsBefore = await this.crypto.verifyPassword(user.passwordHash, newPassword);
    if (sameAsBefore) {
      throw ApiException.unprocessable(ErrorCode.VALIDATION_FAILED, undefined, {
        newPassword: ['Yeni şifre mevcut şifre ile aynı olamaz.'],
      });
    }

    const passwordHash = await this.crypto.hashPassword(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          mustChangePassword: false,
        },
      });

      await this.auditService.record(
        {
          tenantId: user.tenantId,
          action: AuditAction.AUTH_PASSWORD_CHANGED,
          actorUserId: user.id,
          actorRole: user.role,
          actorEmail: user.email,
          companyId: user.companyId,
          resourceType: 'user',
          resourceId: user.id,
          payload: { forced: true },
        },
        tx,
      );
    });

    await this.invalidateUserSnapshot(user.id);
    await this.tokenService.revokeAllForUser(user.id, 'Zorunlu şifre değişikliği');

    const refreshed = (await this.loadUserWithCompany(user.id)) ?? user;

    // Sifre degistirmek 2FA adimini ATLATMAZ. Zorunlu 2FA'si olan rol,
    // sifreyi degistirdikten sonra da dogrulama adimindan gecmek zorundadir.
    const mfaRequired = refreshed.mfaRequired || isMfaMandatory(refreshed.role as UserRole);
    const mfaEnrolled = refreshed.mfaSecretEnc !== null && refreshed.mfaEnrolledAt !== null;

    if (mfaRequired && !mfaEnrolled) {
      const challenge = await this.tokenService.signChallengeToken(
        refreshed.id,
        refreshed.tenantId,
        TokenType.MFA_ENROLLMENT,
        device.deviceId,
      );
      return {
        outcome: LoginOutcome.MFA_ENROLLMENT_REQUIRED,
        challengeToken: challenge.token,
        expiresIn: challenge.expiresIn,
      };
    }

    if (mfaEnrolled && !(await this.isTrustedDevice(refreshed.id, device.deviceId))) {
      const challenge = await this.tokenService.signChallengeToken(
        refreshed.id,
        refreshed.tenantId,
        TokenType.MFA_CHALLENGE,
        device.deviceId,
      );
      return {
        outcome: LoginOutcome.MFA_REQUIRED,
        challengeToken: challenge.token,
        method: refreshed.mfaMethod === MfaMethod.SMS ? 'SMS' : 'TOTP',
        maskedPhone: this.maskPhone(refreshed),
        expiresIn: challenge.expiresIn,
      };
    }

    const issued = await this.completeLogin(refreshed, device, { mfaUsed: 'NONE' });
    return { outcome: LoginOutcome.SUCCESS, tokens: issued.tokens, user: issued.user };
  }

  // =========================================================================
  // Masquerading (plasiyerin bayi yerine gecmesi)
  // =========================================================================

  async startMasquerade(
    salesRepUserId: string,
    tenantId: string,
    dto: StartMasqueradeRequest,
    device: DeviceInfo,
  ): Promise<{ tokens: TokenPair; user: SessionUser }> {
    const context = this.requireContext();

    const assignment = await this.prisma.salesRepAssignment.findFirst({
      where: {
        salesRepUserId,
        companyId: dto.companyId,
        isActive: true,
        company: { tenantId, isActive: true },
      },
      include: { company: true },
    });

    if (!assignment) {
      throw ApiException.forbidden(ErrorCode.MASQUERADE_NOT_ALLOWED);
    }

    const user = await this.loadUserWithCompany(salesRepUserId);
    if (!user) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }

    const owner: SessionOwner = {
      userId: user.id,
      tenantId: user.tenantId,
      companyId: user.companyId,
      role: user.role as UserRole,
    };

    const issued = await this.tokenService.createSession({
      owner,
      device,
      ip: context.ip,
      userAgent: context.userAgent,
      masqueradeCompanyId: dto.companyId,
      masqueradeReason: dto.reason,
    });

    await this.auditService.record({
      tenantId,
      action: AuditAction.MASQUERADE_STARTED,
      actorUserId: salesRepUserId,
      actorRole: user.role,
      actorEmail: user.email,
      onBehalfOfCompanyId: dto.companyId,
      resourceType: 'company',
      resourceId: dto.companyId,
      payload: {
        reason: dto.reason,
        companyTitle: assignment.company.title,
        logoCariCode: assignment.company.logoCariCode,
        sessionId: issued.sessionId,
      },
    });

    return {
      tokens: this.toTokenPair(issued),
      user: await this.buildSessionUser(user, dto.companyId, new Date()),
    };
  }

  async endMasquerade(
    salesRepUserId: string,
    tenantId: string,
    sessionId: string,
    device: DeviceInfo,
  ): Promise<{ tokens: TokenPair; user: SessionUser }> {
    const context = this.requireContext();

    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { masqueradeCompanyId: true, userId: true },
    });

    if (!session || session.userId !== salesRepUserId || !session.masqueradeCompanyId) {
      throw ApiException.badRequest(ErrorCode.CONFLICT, 'Aktif bir vekâlet oturumu yok.');
    }

    const user = await this.loadUserWithCompany(salesRepUserId);
    if (!user) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }

    const issued = await this.tokenService.createSession({
      owner: {
        userId: user.id,
        tenantId: user.tenantId,
        companyId: user.companyId,
        role: user.role as UserRole,
      },
      device,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await this.tokenService.revokeSession(sessionId, 'Vekâlet sonlandırıldı');

    await this.auditService.record({
      tenantId,
      action: AuditAction.MASQUERADE_ENDED,
      actorUserId: salesRepUserId,
      actorRole: user.role,
      actorEmail: user.email,
      onBehalfOfCompanyId: session.masqueradeCompanyId,
      resourceType: 'company',
      resourceId: session.masqueradeCompanyId,
      payload: { endedSessionId: sessionId, newSessionId: issued.sessionId },
    });

    return {
      tokens: this.toTokenPair(issued),
      user: await this.buildSessionUser(user, null, null),
    };
  }

  // =========================================================================
  // Oturum bilgisi
  // =========================================================================

  async getSessionUser(userId: string, sessionId: string): Promise<SessionUser> {
    const user = await this.loadUserWithCompany(userId);
    if (!user) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }

    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { masqueradeCompanyId: true, masqueradeStartedAt: true },
    });

    return this.buildSessionUser(
      user,
      session?.masqueradeCompanyId ?? null,
      session?.masqueradeStartedAt ?? null,
    );
  }

  async listActiveSessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        deviceName: true,
        platform: true,
        ip: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });

    return sessions.map((session) => ({
      id: session.id,
      deviceName: session.deviceName,
      platform: session.platform,
      ip: session.ip,
      city: null,
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      current: session.id === currentSessionId,
    }));
  }

  async revokeSessionById(
    userId: string,
    tenantId: string,
    targetSessionId: string,
  ): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: targetSessionId },
      select: { userId: true },
    });

    if (!session || session.userId !== userId) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND);
    }

    await this.tokenService.revokeSession(targetSessionId, 'Kullanıcı tarafından sonlandırıldı');

    await this.auditService.recordSafely({
      tenantId,
      action: AuditAction.AUTH_SESSION_REVOKED,
      actorUserId: userId,
      resourceType: 'session',
      resourceId: targetSessionId,
      payload: {},
    });
  }

  // =========================================================================
  // Yardimcilar
  // =========================================================================

  private requireContext() {
    const context = getRequestContext();
    if (!context) {
      throw ApiException.internal(ErrorCode.INTERNAL_ERROR, 'İstek bağlamı bulunamadı.');
    }
    return context;
  }

  private async resolveUser(
    emailNormalized: string,
    tenantCode: string | null,
  ): Promise<UserWithCompany | null> {
    const candidates = await this.prisma.user.findMany({
      where: {
        emailNormalized,
        deletedAt: null,
        ...(tenantCode ? { tenant: { code: tenantCode } } : {}),
      },
      include: { company: true },
      take: 5,
    });

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0] ?? null;

    // Ayni e-posta birden fazla kiracida tanimliysa kiraci kodu zorunludur.
    this.logger.warn(
      `"${emailNormalized}" adresi ${candidates.length} kiracıda tanımlı; ` +
        `X-Tenant-Code başlığı olmadan giriş yapılamaz.`,
    );
    return null;
  }

  private async loadUserWithCompany(userId: string): Promise<UserWithCompany | null> {
    return this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { company: true },
    });
  }

  private async assertAccountUsable(
    user: UserWithCompany,
    emailNormalized: string,
  ): Promise<void> {
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.recordLoginAttempt({
        tenantId: user.tenantId,
        emailNormalized,
        userId: user.id,
        success: false,
        failureReason: LoginFailureReason.ACCOUNT_LOCKED,
      });
      throw ApiException.forbidden(ErrorCode.ACCOUNT_LOCKED);
    }

    if (user.status === UserStatus.SUSPENDED) {
      await this.recordLoginAttempt({
        tenantId: user.tenantId,
        emailNormalized,
        userId: user.id,
        success: false,
        failureReason: LoginFailureReason.ACCOUNT_SUSPENDED,
      });
      throw ApiException.forbidden(ErrorCode.ACCOUNT_SUSPENDED);
    }

    if (user.status === UserStatus.INVITED) {
      await this.recordLoginAttempt({
        tenantId: user.tenantId,
        emailNormalized,
        userId: user.id,
        success: false,
        failureReason: LoginFailureReason.ACCOUNT_INVITED,
      });
      throw ApiException.forbidden(ErrorCode.ACCOUNT_INVITED_NOT_ACTIVE);
    }
  }

  private async assertIpAllowedForRole(
    user: UserWithCompany,
    emailNormalized: string,
  ): Promise<void> {
    if (!isIpWhitelistEnforced(user.role as UserRole)) return;
    if (!this.config.SUPER_ADMIN_IP_WHITELIST_ENFORCED) return;

    const context = this.requireContext();
    const now = new Date();

    const rows = await this.prisma.adminIpWhitelist.findMany({
      where: {
        tenantId: user.tenantId,
        isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { cidr: true },
    });

    const allowed = rows.length > 0 && isIpAllowed(context.ip, rows.map((row) => row.cidr));
    if (allowed) return;

    await this.recordLoginAttempt({
      tenantId: user.tenantId,
      emailNormalized,
      userId: user.id,
      success: false,
      failureReason: LoginFailureReason.IP_NOT_WHITELISTED,
    });

    await this.auditService.recordSafely({
      tenantId: user.tenantId,
      action: AuditAction.AUTH_IP_REJECTED,
      outcome: 'DENIED',
      actorUserId: user.id,
      actorRole: user.role,
      actorEmail: user.email,
      payload: { clientIp: context.ip, country: context.country, city: context.city },
    });

    throw ApiException.forbidden(ErrorCode.IP_NOT_WHITELISTED);
  }

  private async registerFailedAttempt(
    user: UserWithCompany,
    emailNormalized: string,
    reason: LoginFailureReason = LoginFailureReason.BAD_PASSWORD,
  ): Promise<void> {
    const attempts = user.failedLoginCount + 1;
    const shouldLock = attempts >= this.config.LOGIN_MAX_ATTEMPTS;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: attempts,
        lockedUntil: shouldLock
          ? new Date(Date.now() + this.config.LOGIN_LOCK_MINUTES * 60_000)
          : user.lockedUntil,
      },
    });

    await this.recordLoginAttempt({
      tenantId: user.tenantId,
      emailNormalized,
      userId: user.id,
      success: false,
      failureReason: reason,
    });

    await this.auditService.recordSafely({
      tenantId: user.tenantId,
      action: shouldLock ? AuditAction.AUTH_ACCOUNT_LOCKED : AuditAction.AUTH_LOGIN_FAILED,
      outcome: 'FAILURE',
      actorUserId: user.id,
      actorRole: user.role,
      actorEmail: user.email,
      companyId: user.companyId,
      payload: { attempts, reason, lockMinutes: shouldLock ? this.config.LOGIN_LOCK_MINUTES : 0 },
    });

    if (shouldLock) {
      await this.invalidateUserSnapshot(user.id);
      await this.tokenService.revokeAllForUser(user.id, 'Hesap kilitlendi');
    }
  }

  private async resetFailureCounters(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: this.requireContext().ip,
        lastLoginCity: this.requireContext().city,
      },
    });
    await this.invalidateUserSnapshot(userId);
  }

  private async recordLoginAttempt(input: {
    tenantId: string | null;
    emailNormalized: string;
    userId: string | null;
    success: boolean;
    failureReason: LoginFailureReason | null;
  }): Promise<void> {
    const context = getRequestContext();

    try {
      await this.prisma.loginAttempt.create({
        data: {
          tenantId: input.tenantId,
          emailNormalized: input.emailNormalized,
          userId: input.userId,
          success: input.success,
          failureReason: input.failureReason,
          ip: context?.ip ?? '0.0.0.0',
          userAgent: context?.userAgent ?? null,
          country: context?.country ?? null,
          city: context?.city ?? null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Giriş denemesi kaydedilemedi: ${message}`);
    }
  }

  private async isTrustedDevice(userId: string, deviceId: string): Promise<boolean> {
    const device = await this.prisma.trustedDevice.findUnique({
      where: { userId_deviceIdHash: { userId, deviceIdHash: this.crypto.sha256(deviceId) } },
      select: { trustedUntil: true, revokedAt: true },
    });

    if (!device || device.revokedAt !== null) return false;
    return device.trustedUntil.getTime() > Date.now();
  }

  private async rememberDevice(userId: string, device: DeviceInfo): Promise<void> {
    const deviceIdHash = this.crypto.sha256(device.deviceId);
    const trustedUntil = new Date(Date.now() + TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000);
    const context = getRequestContext();

    await this.prisma.trustedDevice.upsert({
      where: { userId_deviceIdHash: { userId, deviceIdHash } },
      update: {
        trustedUntil,
        revokedAt: null,
        lastSeenAt: new Date(),
        lastSeenIp: context?.ip ?? null,
        deviceName: device.deviceName,
      },
      create: {
        userId,
        deviceIdHash,
        deviceName: device.deviceName,
        platform: device.platform === 'IOS' ? 'IOS' : device.platform === 'ANDROID' ? 'ANDROID' : 'WEB',
        trustedUntil,
        lastSeenIp: context?.ip ?? null,
      },
    });
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const candidates = await this.prisma.mfaRecoveryCode.findMany({
      where: { userId, usedAt: null },
      select: { id: true, codeHash: true },
    });

    const normalized = code.trim().toUpperCase();

    for (const candidate of candidates) {
      const matches = await this.crypto.verifyPassword(candidate.codeHash, normalized);
      if (!matches) continue;

      const context = getRequestContext();
      const result = await this.prisma.mfaRecoveryCode.updateMany({
        where: { id: candidate.id, usedAt: null },
        data: { usedAt: new Date(), usedIp: context?.ip ?? null },
      });

      // updateMany 0 dondurduyse kod ayni anda baska bir istek tarafindan
      // tuketilmis demektir; gecerli sayilmaz.
      return result.count === 1;
    }

    return false;
  }

  private async completeLogin(
    user: UserWithCompany,
    device: DeviceInfo,
    meta: { mfaUsed: string },
  ): Promise<{ tokens: TokenPair; user: SessionUser }> {
    const context = this.requireContext();

    const issued = await this.tokenService.createSession({
      owner: {
        userId: user.id,
        tenantId: user.tenantId,
        companyId: user.companyId,
        role: user.role as UserRole,
      },
      device,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await this.auditService.record({
      tenantId: user.tenantId,
      action: AuditAction.AUTH_LOGIN_SUCCESS,
      actorUserId: user.id,
      actorRole: user.role,
      actorEmail: user.email,
      companyId: user.companyId,
      resourceType: 'session',
      resourceId: issued.sessionId,
      payload: {
        platform: device.platform,
        deviceName: device.deviceName,
        appVersion: device.appVersion ?? null,
        mfaUsed: meta.mfaUsed,
        country: context.country,
        city: context.city,
      },
    });

    return {
      tokens: this.toTokenPair(issued),
      user: await this.buildSessionUser(user, null, null),
    };
  }

  private toTokenPair(issued: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }): TokenPair {
    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      tokenType: 'Bearer',
      expiresIn: issued.expiresIn,
    };
  }

  private async buildSessionUser(
    user: UserWithCompany,
    masqueradeCompanyId: string | null,
    masqueradeStartedAt: Date | null,
  ): Promise<SessionUser> {
    const role = user.role as UserRole;

    let masqueradingAs: SessionUser['masqueradingAs'] = null;

    if (masqueradeCompanyId) {
      const target = await this.prisma.company.findUnique({
        where: { id: masqueradeCompanyId },
        select: { id: true, title: true },
      });

      if (target) {
        masqueradingAs = {
          companyId: target.id,
          companyTitle: target.title,
          startedAt: (masqueradeStartedAt ?? new Date()).toISOString(),
        };
      }
    }

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role,
      roleLabel: ROLE_LABELS[role],
      permissions: [...getPermissionsForRole(role)],
      tenantId: user.tenantId,
      companyId: user.companyId,
      companyTitle: user.company?.title ?? null,
      blindOrderMode: isBlindOrderRole(role),
      mfaEnrolled: user.mfaSecretEnc !== null && user.mfaEnrolledAt !== null,
      primaryPlatform: ROLE_PRIMARY_PLATFORM[role],
      masqueradingAs,
    };
  }

  private maskPhone(user: UserWithCompany): string | null {
    if (!user.phoneEnc) return null;

    try {
      const phone = this.crypto.decryptField(user.phoneEnc);
      if (phone.length < 4) return null;
      return `••• ••• ${phone.slice(-4, -2)} ${phone.slice(-2)}`;
    } catch {
      return null;
    }
  }

  private async invalidateUserSnapshot(userId: string): Promise<void> {
    await this.redis.delete(userSnapshotCacheKey(userId));
  }
}
