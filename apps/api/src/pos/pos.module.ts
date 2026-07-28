import { Module } from '@nestjs/common';

import { FinanceModule } from '../finance/finance.module';
import { DbsController } from './dbs.controller';
import { DbsService } from './dbs.service';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';

@Module({
  imports: [FinanceModule],
  controllers: [PosController, DbsController],
  providers: [PosService, DbsService],
  exports: [PosService, DbsService],
})
export class PosModule {}
