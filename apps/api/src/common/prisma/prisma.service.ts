import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@toptanportal/db';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'production'
          ? [{ level: 'warn', emit: 'stdout' }, { level: 'error', emit: 'stdout' }]
          : [
              { level: 'warn', emit: 'stdout' },
              { level: 'error', emit: 'stdout' },
            ],
      errorFormat: process.env.NODE_ENV === 'production' ? 'minimal' : 'pretty',
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Veritabanı bağlantısı kuruldu.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Veritabanına bağlanılamadı: ${message}`);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Veritabanı bağlantısı kapatıldı.');
  }

  /** Sağlık kontrolü için hafif bir sorgu. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Veritabanı sağlık kontrolü başarısız: ${message}`);
      return false;
    }
  }
}
