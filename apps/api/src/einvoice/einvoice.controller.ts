/**
 * ToptanPortal API - e-Belge Arsivi Uc Noktalari
 *
 * Listeleme ve baglanti uretimi INVOICE_DOWNLOAD yetkisi ister. Dosya akitan
 * uc ise oturumsuzdur: tarayici imzali baglantiyi dogrudan cagirir ve o
 * baglanti, kimin indirdigini kendi icinde tasir.
 *
 * Kor Siparis Modundaki alt yetkilinin rol matrisinde INVOICE_DOWNLOAD
 * bulunmaz; fatura tutar tasir ve tutar o hesaba gosterilmez.
 */

import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  EDocumentFormat,
  Permission,
  eDocumentBulkSchema,
  eDocumentQuerySchema,
  issueEDocumentSchema,
  type EDocumentBulkRequest,
  type EDocumentLink,
  type EDocumentPage,
  type EDocumentQuery,
  type EDocumentSummary,
  type IssueEDocumentRequest,
  type IssueEDocumentResult,
} from '@toptanportal/contracts';

import { ClientIp, CurrentUser, Public, RateLimit, RequirePermissions } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { EDocumentIssueService } from './edocument-issue.service';
import { EInvoiceService } from './einvoice.service';

@ApiTags('e-Belge Arşivi')
@Controller('e-documents')
export class EInvoiceController {
  constructor(
    private readonly invoices: EInvoiceService,
    private readonly issuer: EDocumentIssueService,
  ) {}

  /**
   * Siparisten belge keser.
   *
   * GERI ALINAMAZ: numara tuketilir, belge hukuken dogar ve duzeltmesi ancak
   * iade faturasiyla yapilir. Hiz siniri bu yuzden dardir - toplu ve yanlislikla
   * yapilan bir cagri, defteri bosuna doldurur.
   *
   * Uc nokta belgeyi KESER, GONDERMEZ. Iletim bakim gorevinden yapilir; aksi
   * halde kullanicinin istegi entegratorun yanit suresine baglanirdi ve zaman
   * asiminda belgenin kesilip kesilmedigi bilinemezdi.
   */
  @Post('issue')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.EDOCUMENT_ISSUE)
  @RateLimit({ limit: 60, windowSeconds: 300, scope: 'USER' })
  @ApiOperation({ summary: 'Siparişten e-Belge kes' })
  issue(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(issueEDocumentSchema)) body: IssueEDocumentRequest,
  ): Promise<IssueEDocumentResult> {
    return this.issuer.issueFromOrder(principal, body);
  }

  @Get()
  @RequirePermissions(Permission.INVOICE_DOWNLOAD)
  @ApiOperation({ summary: 'e-Belge listesi' })
  list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(eDocumentQuerySchema)) query: EDocumentQuery,
  ): Promise<EDocumentPage> {
    return this.invoices.list(principal, query);
  }

  @Get('summary')
  @RequirePermissions(Permission.INVOICE_DOWNLOAD)
  @ApiOperation({ summary: 'Dönem özeti' })
  summary(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(eDocumentQuerySchema)) query: EDocumentQuery,
  ): Promise<EDocumentSummary> {
    return this.invoices.summary(principal, query);
  }

  /**
   * Kisa omurlu indirme baglantisi uretir.
   *
   * Hiz siniri toplu indirmeye izin verecek kadar genis, arsivi tarayarak
   * kazimaya izin vermeyecek kadar dardir.
   */
  @Get(':documentId/link')
  @RequirePermissions(Permission.INVOICE_DOWNLOAD)
  @RateLimit({ limit: 120, windowSeconds: 300, scope: 'USER' })
  @ApiOperation({ summary: 'İndirme bağlantısı oluştur' })
  link(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @Query('format') format?: EDocumentFormat,
  ): Promise<EDocumentLink> {
    return this.invoices.createLink(principal, documentId, format ?? EDocumentFormat.PDF);
  }

  @Post('bulk-links')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.INVOICE_DOWNLOAD)
  @RateLimit({ limit: 10, windowSeconds: 600, scope: 'USER' })
  @ApiOperation({ summary: 'Toplu indirme bağlantıları' })
  bulkLinks(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(eDocumentBulkSchema)) body: EDocumentBulkRequest,
  ): Promise<{ links: EDocumentLink[]; skippedCount: number }> {
    return this.invoices.createBulkLinks(principal, body.documentIds, body.format);
  }

  /**
   * Dosyayi akitir.
   *
   * `@Public()`: baglanti imzalidir ve indiren kisiyi icinde tasir; tarayici
   * bu adrese yeni sekmede giderken Authorization basligi gonderemez.
   *
   * Belge ADI ve TURU yaniti belirler; icerik hicbir kosulda satir ici
   * (inline) sunulmaz - `attachment`, XML'in tarayicida calisan bir seye
   * donusme ihtimalini ortadan kaldirir.
   */
  @Get('file')
  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiExcludeEndpoint()
  async file(
    @Query('token') token: string,
    @ClientIp() ip: string | null,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const ticket = token ? this.invoices.verifyTicket(token) : null;

    if (ticket === null) {
      response.status(403);
      throw new Error('Bağlantı geçersiz veya süresi dolmuş.');
    }

    const sonuc = await this.invoices.openForTicket(ticket, ip);

    if (sonuc === null) {
      response.status(404);
      throw new Error('Belge bulunamadı.');
    }

    response.setHeader(
      'Content-Type',
      ticket.format === EDocumentFormat.PDF
        ? 'application/pdf'
        : ticket.format === EDocumentFormat.XML
          ? 'application/xml'
          : 'application/zip',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${sonuc.fileName}"`,
    );

    return new StreamableFile(sonuc.stream);
  }
}
