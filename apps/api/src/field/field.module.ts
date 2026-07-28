import { Module } from '@nestjs/common';

import { FieldController } from './field.controller';
import { PortfolioService } from './portfolio.service';
import { TargetService } from './target.service';
import { VisitService } from './visit.service';

@Module({
  controllers: [FieldController],
  providers: [PortfolioService, VisitService, TargetService],
  exports: [PortfolioService, VisitService, TargetService],
})
export class FieldModule {}
