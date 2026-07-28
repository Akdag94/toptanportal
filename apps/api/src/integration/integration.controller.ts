/**
 * ToptanPortal API - Entegrasyon Yonetimi Uc Noktalari
 *
 * Tumu INTEGRATION_MANAGE yetkisi ister; bu yetki yalnizca Super Admin
 * rolundedir. Elle senkron tetiklemek Logo'ya yuk bindirir ve tam senkron
 * saatler surebilir - bayi veya plasiyer bu dugmeye erisemez.
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  retryEventSchema,
  triggerSyncSchema,
  type DeadEventView,
  type IntegrationStatus,
  type RetryEventRequest,
  type SyncRunResult,
  type TriggerSyncRequest,
} from '@toptanportal/contracts';

import { CurrentUser, RateLimit, RequirePermissions } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { IntegrationService } from './integration.service';

@ApiTags('Logo Entegrasyonu')
@Controller('integration')
@RequirePermissions(Permission.INTEGRATION_MANAGE)
export class IntegrationController {
  constructor(private readonly integration: IntegrationService) {}

  @Get('status')
  @ApiOperation({ summary: 'Entegrasyon durumu ve kanal sağlığı' })
  status(@CurrentUser() principal: AuthenticatedPrincipal): Promise<IntegrationStatus> {
    return this.integration.status(principal.tenantId);
  }

  /**
   * Koprüyu ANINDA yoklar. Durum ekranindaki deger en son zamanlanmis
   * yoklamadan gelir; operator "simdi nasil?" sorusunu bu ucla sorar.
   */
  @Post('probe')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 20, windowSeconds: 300, scope: 'USER' })
  @ApiOperation({ summary: 'Köprüyü şimdi yokla' })
  async probe(@CurrentUser() principal: AuthenticatedPrincipal): Promise<IntegrationStatus> {
    await this.integration.probe(principal.tenantId);
    return this.integration.status(principal.tenantId);
  }

  @Get('dead-events')
  @ApiOperation({ summary: 'Elle müdahale bekleyen olaylar' })
  deadEvents(@CurrentUser() principal: AuthenticatedPrincipal): Promise<DeadEventView[]> {
    return this.integration.deadEvents(principal.tenantId);
  }

  @Post('dead-events/retry')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 10, windowSeconds: 300, scope: 'USER' })
  @ApiOperation({ summary: 'Ölü olayları yeniden kuyruğa al' })
  async retry(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(retryEventSchema)) body: RetryEventRequest,
  ): Promise<{ requeued: number }> {
    const requeued = await this.integration.retryDeadEvents(principal.tenantId, body.eventIds);
    return { requeued };
  }

  /**
   * Tam senkron pahalidir; hiz siniri bu yuzden dardir. Ard arda tetiklenen
   * tam senkron, Logo veritabanini portalin okumasiyla mesgul eder ve
   * toptancinin kendi personelini yavaslatir.
   */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 6, windowSeconds: 600, scope: 'USER' })
  @ApiOperation({ summary: 'Senkron kanalını elle çalıştır' })
  trigger(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(triggerSyncSchema)) body: TriggerSyncRequest,
  ): Promise<SyncRunResult | null> {
    return this.integration.trigger(principal.tenantId, body.channel, body.fullResync);
  }

  @Post('channels/toggle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Senkron kanalını aç / kapat' })
  async toggle(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query('channel') channel: TriggerSyncRequest['channel'],
    @Query('enabled') enabled: string,
  ): Promise<IntegrationStatus> {
    await this.integration.setChannelEnabled(principal.tenantId, channel, enabled === 'true');
    return this.integration.status(principal.tenantId);
  }
}
