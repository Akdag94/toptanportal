/**
 * e-Belge modulu.
 *
 * ARSIV/SUNUM ile URETIM HATTI ayni modulde durur ama ayri servislerdir:
 * arsiv, entegrator yapilandirilmamis olsa da calisir. Yapilandirmasi olmayan
 * bir kurulumda belge KESILEMEZ; kesilmis belgeler goruntulenmeye devam eder -
 * saklama yukumlulugu, uretim yeteneginden bagimsizdir.
 */

import { Module } from '@nestjs/common';

import { DocumentStorageService } from './document-storage.service';
import { EDocumentDispatchService } from './edocument-dispatch.service';
import { EDocumentIssueService } from './edocument-issue.service';
import { EInvoiceController } from './einvoice.controller';
import { EInvoiceProvider } from './einvoice-provider';
import { EInvoiceService } from './einvoice.service';

@Module({
  controllers: [EInvoiceController],
  providers: [
    EInvoiceService,
    DocumentStorageService,
    EInvoiceProvider,
    EDocumentIssueService,
    EDocumentDispatchService,
  ],
  exports: [EInvoiceService, EDocumentDispatchService],
})
export class EInvoiceModule {}
