import { Module } from '@nestjs/common';

import { DocumentStorageService } from './document-storage.service';
import { EInvoiceController } from './einvoice.controller';
import { EInvoiceService } from './einvoice.service';

@Module({
  controllers: [EInvoiceController],
  providers: [EInvoiceService, DocumentStorageService],
  exports: [EInvoiceService],
})
export class EInvoiceModule {}
