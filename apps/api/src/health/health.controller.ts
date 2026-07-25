/**
 * ToptanPortal - Saglik Uc Noktalari
 *
 * /health/live  : surec ayakta mi (Kubernetes liveness)
 * /health/ready : bagimliliklar hazir mi (Kubernetes readiness)
 *
 * Readiness, veritabani veya Redis erisilemezse 503 doner ve yuk dengeleyici
 * trafigi bu ornege yonlendirmez.
 */

import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../common/decorators';
import { ApiException } from '../common/exceptions/api.exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ErrorCode } from '@toptanportal/contracts';

interface ReadinessReport {
  status: 'HAZIR' | 'HAZIR_DEGIL';
  checks: { database: boolean; redis: boolean };
  timestamp: string;
}

@ApiTags('Sağlık')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Süreç ayakta mı' })
  live(): { status: string; timestamp: string } {
    return { status: 'AYAKTA', timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bağımlılıklar hazır mı' })
  async ready(): Promise<ReadinessReport> {
    const [database, redis] = await Promise.all([this.prisma.ping(), this.redis.ping()]);

    const report: ReadinessReport = {
      status: database && redis ? 'HAZIR' : 'HAZIR_DEGIL',
      checks: { database, redis },
      timestamp: new Date().toISOString(),
    };

    if (report.status === 'HAZIR_DEGIL') {
      throw ApiException.serviceUnavailable(
        ErrorCode.INTERNAL_ERROR,
        `Servis hazır değil. Veritabanı: ${database ? 'tamam' : 'hata'}, Redis: ${redis ? 'tamam' : 'hata'}`,
      );
    }

    return report;
  }
}
