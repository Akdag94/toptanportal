import { Module } from '@nestjs/common';

import { FinanceModule } from '../finance/finance.module';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';

@Module({
  imports: [FinanceModule],
  controllers: [PosController],
  providers: [PosService],
  exports: [PosService],
})
export class PosModule {}
