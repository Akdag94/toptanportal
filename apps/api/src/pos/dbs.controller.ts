/**
 * ToptanPortal API - DBS Uc Noktalari
 *
 * Tumu COMPANY_MANAGE ister: DBS dosyasi bankaya gonderildiginde bayiden para
 * cekilir. Bu, portaldeki en geri donusu zor islemdir ve bayi kullanicisinin
 * eline verilmez.
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  dbsExportQuerySchema,
  dbsImportSchema,
  type DbsBatchView,
  type DbsExportQuery,
  type DbsImportRequest,
  type DbsImportResult,
} from '@toptanportal/contracts';

import { CurrentUser, RateLimit, RequirePermissions } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { DbsService, type DbsExportResult } from './dbs.service';

@ApiTags('DBS')
@Controller('dbs')
@RequirePermissions(Permission.COMPANY_MANAGE)
export class DbsController {
  constructor(private readonly dbs: DbsService) {}

  @Get('batches')
  @ApiOperation({ summary: 'DBS dosya geçmişi' })
  batches(@CurrentUser() principal: AuthenticatedPrincipal): Promise<DbsBatchView[]> {
    return this.dbs.listBatches(principal);
  }

  /**
   * Borc dosyasi uretir VE kayitlari bankada bekliyor isaretler.
   *
   * Dosyayi uretmeden once isaretlemek zorunludur: uretilen dosya indirilip
   * bankaya yuklenebilir ve portal bunu bilemez. Ikinci bir disa aktarim ayni
   * belgeyi tekrar gonderirse bayiden iki kez tahsilat yapilir.
   */
  @Post('export')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ limit: 5, windowSeconds: 600, scope: 'USER' })
  @ApiOperation({ summary: 'Borç dosyası oluştur' })
  export(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(dbsExportQuerySchema)) query: DbsExportQuery,
  ): Promise<DbsExportResult> {
    return this.dbs.exportDebts(principal, query);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 10, windowSeconds: 600, scope: 'USER' })
  @ApiOperation({ summary: 'Banka sonuç dosyasını işle' })
  import(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(dbsImportSchema)) body: DbsImportRequest,
  ): Promise<DbsImportResult> {
    return this.dbs.importResults(principal, body);
  }
}
