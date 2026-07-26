import { Global, Module } from '@nestjs/common';

import { CompanyScopeService } from './company-scope.service';

/**
 * Cari kapsam cozumleyicisi neredeyse her is modulunde gerekir; her modulde
 * yeniden saglayici tanimlamak yerine global olarak sunulur.
 */
@Global()
@Module({
  providers: [CompanyScopeService],
  exports: [CompanyScopeService],
})
export class CompanyScopeModule {}
