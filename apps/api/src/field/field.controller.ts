/**
 * ToptanPortal API - Saha Uc Noktalari
 *
 * Portfoy ve ziyaret uclari plasiyerin gunluk araclaridir; hedef ucu ise iki
 * ayri kitleye bakar: plasiyer KENDI hedefini gorur, yonetici hepsini gorur ve
 * tanimlar. Ayrimi servis katmani yapar - denetleyicide tek yetki gibi durup
 * icerde ayrisan bir kural, ilk okumada yanlis anlasilir; bu yuzden iki ayri
 * uc tanimlanmistir.
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  assignRepSchema,
  companyListQuerySchema,
  createVisitNoteSchema,
  salesTargetQuerySchema,
  upsertSalesTargetSchema,
  visitNoteQuerySchema,
  type AssignRepRequest,
  type CompanyListQuery,
  type CompanyPage,
  type CreateVisitNoteRequest,
  type SalesTarget,
  type SalesTargetQuery,
  type UpsertSalesTargetRequest,
  type VisitNote,
  type VisitNotePage,
  type VisitNoteQuery,
} from '@toptanportal/contracts';

import { CurrentUser, RateLimit, RequireAnyPermission, RequirePermissions } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { PortfolioService } from './portfolio.service';
import { TargetService } from './target.service';
import { VisitService } from './visit.service';

@ApiTags('Saha')
@Controller()
export class FieldController {
  constructor(
    private readonly portfolio: PortfolioService,
    private readonly visits: VisitService,
    private readonly targets: TargetService,
  ) {}

  // --- Bayi portfoyu ---

  @Get('companies')
  @RequireAnyPermission(Permission.COMPANY_VIEW_ASSIGNED, Permission.COMPANY_VIEW_ALL)
  @ApiOperation({ summary: 'Bayi portföyü' })
  companies(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(companyListQuerySchema)) query: CompanyListQuery,
  ): Promise<CompanyPage> {
    return this.portfolio.list(principal, query);
  }

  @Post('companies/assignments')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.COMPANY_MANAGE)
  @ApiOperation({ summary: 'Plasiyere bayi ata / atamayı kaldır' })
  assign(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(assignRepSchema)) body: AssignRepRequest,
  ): Promise<{ affected: number }> {
    return this.portfolio.assign(principal, body.salesRepUserId, body.companyIds, body.assign);
  }

  // --- Ziyaret notlari ---

  @Get('visits')
  @RequirePermissions(Permission.VISIT_NOTE_MANAGE)
  @ApiOperation({ summary: 'Ziyaret notları' })
  visitList(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(visitNoteQuerySchema)) query: VisitNoteQuery,
  ): Promise<VisitNotePage> {
    return this.visits.list(principal, query);
  }

  @Post('visits')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.VISIT_NOTE_MANAGE)
  @RateLimit({ limit: 60, windowSeconds: 600, scope: 'USER' })
  @ApiOperation({ summary: 'Ziyaret notu ekle' })
  visitCreate(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(createVisitNoteSchema)) body: CreateVisitNoteRequest,
  ): Promise<VisitNote> {
    return this.visits.create(principal, body);
  }

  // --- Hedef ve prim ---

  @Get('sales-targets')
  @RequireAnyPermission(Permission.SALES_TARGET_VIEW_OWN, Permission.SALES_TARGET_MANAGE)
  @ApiOperation({ summary: 'Hedef ve prim durumu' })
  targetList(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(salesTargetQuerySchema)) query: SalesTargetQuery,
  ): Promise<SalesTarget[]> {
    return this.targets.list(principal, query);
  }

  @Post('sales-targets')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SALES_TARGET_MANAGE)
  @ApiOperation({ summary: 'Hedef tanımla' })
  targetUpsert(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(upsertSalesTargetSchema)) body: UpsertSalesTargetRequest,
  ): Promise<SalesTarget> {
    return this.targets.upsert(principal, body);
  }
}
