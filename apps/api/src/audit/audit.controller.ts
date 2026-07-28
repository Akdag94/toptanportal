/**
 * ToptanPortal API - Denetim Kaydi Uc Noktalari
 *
 * AUDIT_LOG_VIEW yalnizca Super Admin rolundedir. Denetim kaydi, kimin neyi ne
 * zaman yaptigini gosterir; bunu isletme kullanicisina acmak, calisanlarin
 * birbirini izlemesine kapi aralar - kayit yasal delil icindir, gozetim icin
 * degil.
 *
 * YAZMA UCU YOKTUR ve olmayacaktir. Kayitlar yalnizca ilgili is akisi icinde,
 * is verisiyle ayni islemde yazilir.
 */

import { Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  auditQuerySchema,
  type AuditPage,
  type AuditQuery,
  type AuditVerifyResult,
} from '@toptanportal/contracts';

import { CurrentUser, RateLimit, RequirePermissions } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { AuditQueryService } from './audit-query.service';

@ApiTags('Denetim')
@Controller('audit')
@RequirePermissions(Permission.AUDIT_LOG_VIEW)
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  @ApiOperation({ summary: 'Denetim kayıtları' })
  list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(auditQuerySchema)) query: AuditQuery,
  ): Promise<AuditPage> {
    return this.audit.list(principal, query);
  }

  /**
   * Zincirin son bolumunu dogrular.
   *
   * Hiz siniri dardir: her cagri binlerce kaydin ozetini yeniden hesaplar ve
   * bu, veritabanini degil CPU'yu mesgul eder.
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 5, windowSeconds: 600, scope: 'USER' })
  @ApiOperation({ summary: 'Zincir bütünlüğünü doğrula' })
  verify(@CurrentUser() principal: AuthenticatedPrincipal): Promise<AuditVerifyResult> {
    return this.audit.verify(principal);
  }
}
