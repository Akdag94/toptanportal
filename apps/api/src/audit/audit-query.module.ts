import { Module } from '@nestjs/common';

import { AuditController } from './audit.controller';
import { AuditQueryService } from './audit-query.service';

@Module({
  controllers: [AuditController],
  providers: [AuditQueryService],
})
export class AuditQueryModule {}
