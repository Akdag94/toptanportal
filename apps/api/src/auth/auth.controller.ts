/**
 * ToptanPortal - Kimlik Dogrulama Uc Noktalari
 *
 * Anonim uc noktalarin tamami hiz sinirlamasi altindadir. Giris ve 2FA
 * dogrulamasi hem IP hem hedef e-posta bazinda sayilir; boylece tek bir IP'den
 * cok sayida hesaba yayilan kaba kuvvet denemeleri de yakalanir.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  changePasswordSchema,
  deviceInfoSchema,
  forcedPasswordChangeSchema,
  loginRequestSchema,
  logoutRequestSchema,
  mfaEnrollConfirmSchema,
  mfaEnrollStartSchema,
  mfaSetupConfirmSchema,
  mfaVerifyRequestSchema,
  refreshRequestSchema,
  startMasqueradeSchema,
  type ActiveSession,
  type ChangePasswordRequest,
  type DeviceInfo,
  type ForcedPasswordChangeRequest,
  type LoginRequest,
  type LoginResponse,
  type LogoutRequest,
  type MfaEnrollConfirmRequest,
  type MfaEnrollConfirmResponse,
  type MfaEnrollStartRequest,
  type MfaEnrollStartResponse,
  type MfaSetupConfirmRequest,
  type MfaVerifyRequest,
  type RefreshRequest,
  type SessionUser,
  type StartMasqueradeRequest,
  type TokenPair,
} from '@toptanportal/contracts';

import {
  CurrentUser,
  Public,
  RateLimit,
  RequirePermissions,
} from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { AuthService } from './auth.service';

const TENANT_HEADER = 'x-tenant-code';

@ApiTags('Kimlik Doğrulama')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // -------------------------------------------------------------------------
  // Anonim akis
  // -------------------------------------------------------------------------

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 10, windowSeconds: 900, scope: 'IP_TARGET', targetField: 'email' })
  @ApiOperation({ summary: 'E-posta ve şifre ile giriş' })
  async login(
    @Body(zodBody(loginRequestSchema)) body: LoginRequest,
    @Headers(TENANT_HEADER) tenantCode?: string,
  ): Promise<LoginResponse> {
    const normalizedTenantCode =
      tenantCode && tenantCode.trim().length > 0 ? tenantCode.trim() : null;
    return this.authService.login(body, normalizedTenantCode);
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 8, windowSeconds: 300, scope: 'IP' })
  @ApiOperation({ summary: 'İki adımlı doğrulama kodunu onayla' })
  async verifyMfa(
    @Body(zodBody(mfaVerifyRequestSchema)) body: MfaVerifyRequest,
  ): Promise<LoginResponse> {
    return this.authService.verifyMfa(body, body.device);
  }

  @Public()
  @Post('mfa/enrollment')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 6, windowSeconds: 900, scope: 'IP' })
  @ApiOperation({ summary: 'Zorunlu iki adımlı doğrulama kaydını başlat' })
  async startEnrollment(
    @Body(zodBody(mfaEnrollStartSchema)) body: MfaEnrollStartRequest,
  ): Promise<MfaEnrollStartResponse> {
    return this.authService.startMandatoryEnrollment(body.challengeToken);
  }

  @Public()
  @Post('mfa/enrollment/confirm')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 8, windowSeconds: 900, scope: 'IP' })
  @ApiOperation({ summary: 'Zorunlu iki adımlı doğrulama kaydını tamamla ve oturum aç' })
  async confirmEnrollment(
    @Body(zodBody(mfaEnrollConfirmSchema)) body: MfaEnrollConfirmRequest,
  ): Promise<MfaEnrollConfirmResponse> {
    return this.authService.confirmMandatoryEnrollment(
      body.enrollmentToken,
      body.code,
      body.device,
    );
  }

  @Public()
  @Post('password/forced-change')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 6, windowSeconds: 900, scope: 'IP' })
  @ApiOperation({ summary: 'Zorunlu şifre değişikliğini tamamla' })
  async forcedPasswordChange(
    @Body(zodBody(forcedPasswordChangeSchema)) body: ForcedPasswordChangeRequest,
  ): Promise<LoginResponse> {
    return this.authService.completeForcedPasswordChange(
      body.challengeToken,
      body.newPassword,
      body.device,
    );
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 60, windowSeconds: 900, scope: 'IP' })
  @ApiOperation({ summary: 'Erişim jetonunu yenile' })
  async refresh(
    @Body(zodBody(refreshRequestSchema)) body: RefreshRequest,
  ): Promise<{ tokens: TokenPair; user: SessionUser }> {
    return this.authService.refresh(body.refreshToken, body.device);
  }

  // -------------------------------------------------------------------------
  // Kimlikli akis
  // -------------------------------------------------------------------------

  @Get('me')
  @ApiOperation({ summary: 'Oturum sahibinin profili ve yetkileri' })
  async me(@CurrentUser() principal: AuthenticatedPrincipal): Promise<SessionUser> {
    return this.authService.getSessionUser(principal.userId, principal.sessionId);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Oturumu kapat' })
  async logout(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(logoutRequestSchema)) body: LogoutRequest,
  ): Promise<{ revokedSessions: number }> {
    return this.authService.logout(
      principal.userId,
      principal.tenantId,
      principal.sessionId,
      body.allDevices,
    );
  }

  @Post('password/change')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 5, windowSeconds: 900, scope: 'USER' })
  @ApiOperation({ summary: 'Şifre değiştir (diğer tüm oturumları kapatır)' })
  async changePassword(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(changePasswordSchema)) body: ChangePasswordRequest,
  ): Promise<{ revokedSessions: number }> {
    return this.authService.changePassword(
      principal.userId,
      principal.tenantId,
      body,
      principal.sessionId,
    );
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Açık oturumları listele' })
  async sessions(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<{ sessions: ActiveSession[] }> {
    const sessions = await this.authService.listActiveSessions(
      principal.userId,
      principal.sessionId,
    );
    return { sessions };
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Belirli bir oturumu sonlandır' })
  async revokeSession(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): Promise<void> {
    await this.authService.revokeSessionById(
      principal.userId,
      principal.tenantId,
      sessionId,
    );
  }

  // -------------------------------------------------------------------------
  // Gonullu 2FA kaydi (zorunlu olmayan roller icin)
  // -------------------------------------------------------------------------

  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 6, windowSeconds: 900, scope: 'USER' })
  @ApiOperation({ summary: 'İki adımlı doğrulama kaydını başlat' })
  async setupMfa(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(deviceInfoSchema)) device: DeviceInfo,
  ): Promise<MfaEnrollStartResponse> {
    return this.authService.startVoluntaryEnrollment(principal.userId, device);
  }

  @Post('mfa/setup/confirm')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 8, windowSeconds: 900, scope: 'USER' })
  @ApiOperation({ summary: 'İki adımlı doğrulama kaydını onayla' })
  async confirmSetupMfa(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(mfaSetupConfirmSchema)) body: MfaSetupConfirmRequest,
  ): Promise<{ recoveryCodes: string[] }> {
    const recoveryCodes = await this.authService.confirmVoluntaryEnrollment(
      principal.userId,
      body.code,
    );
    return { recoveryCodes };
  }

  // -------------------------------------------------------------------------
  // Masquerading - yalnizca plasiyer
  // -------------------------------------------------------------------------

  @Post('masquerade')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.MASQUERADE)
  @RateLimit({ limit: 30, windowSeconds: 900, scope: 'USER' })
  @ApiOperation({ summary: 'Bayi adına işlem yapmaya başla' })
  async startMasquerade(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(startMasqueradeSchema.extend({ device: deviceInfoSchema })))
    body: StartMasqueradeRequest & { device: DeviceInfo },
  ): Promise<{ tokens: TokenPair; user: SessionUser }> {
    return this.authService.startMasquerade(
      principal.userId,
      principal.tenantId,
      { companyId: body.companyId, reason: body.reason },
      body.device,
    );
  }

  @Post('masquerade/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.MASQUERADE)
  @ApiOperation({ summary: 'Bayi adına işlem yapmayı sonlandır' })
  async endMasquerade(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(deviceInfoSchema)) device: DeviceInfo,
  ): Promise<{ tokens: TokenPair; user: SessionUser }> {
    return this.authService.endMasquerade(
      principal.userId,
      principal.tenantId,
      principal.sessionId,
      device,
    );
  }
}
