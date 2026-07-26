/**
 * ToptanPortal - Saglik Uc Noktalari
 *
 * /health/live      : surec ayakta mi (Kubernetes liveness)
 * /health/ready     : bagimliliklar hazir mi (Kubernetes readiness)
 * /health/pipeline  : ticari akisin sikismis noktalari (yalnizca yonetici)
 *
 * Readiness, veritabani veya Redis erisilemezse 503 doner ve yuk dengeleyici
 * trafigi bu ornege yonlendirmez.
 */

import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ErrorCode, Permission } from '@toptanportal/contracts';
import { OrderStatus, OutboxStatus, ReservationStatus } from '@toptanportal/db';

import { Public, RequirePermissions } from '../common/decorators';
import { ApiException } from '../common/exceptions/api.exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';

interface ReadinessReport {
  status: 'HAZIR' | 'HAZIR_DEGIL';
  checks: { database: boolean; redis: boolean };
  timestamp: string;
}

/**
 * Ticari akisin operasyonel gorunumu.
 * Bu sayilar bir isin YAPILMADIGINI degil, BEKLEDIGINI gosterir; bekleme
 * tasarim geregidir, fark edilmemesi degildir.
 */
interface PipelineReport {
  /** Isletme yetkilisinin onayini bekleyen siparisler. */
  onayBekleyen: number;
  /** Onaylanmis, Logo'ya iletilmeyi bekleyen siparisler. */
  kuyruktaBekleyen: number;
  /** Azami deneme sayisi asilmis, manuel mudahale bekleyen olaylar. */
  iletilemeyen: number;
  /** Gonderilmeyi bekleyen outbox olaylari. */
  bekleyenOlay: number;
  /** Suresi dolmus ama henuz serbest birakilmamis stok rezervasyonlari. */
  suresiDolmusRezervasyon: number;
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

  @Get('pipeline')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ADMIN_SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Sipariş akışının bekleyen iş sayıları' })
  async pipeline(): Promise<PipelineReport> {
    const now = new Date();

    const [onayBekleyen, kuyruktaBekleyen, iletilemeyen, bekleyenOlay, suresiDolmusRezervasyon] =
      await Promise.all([
        this.prisma.order.count({ where: { status: OrderStatus.PENDING_APPROVAL } }),
        this.prisma.order.count({ where: { status: OrderStatus.QUEUED } }),
        this.prisma.outboxEvent.count({ where: { status: OutboxStatus.DEAD } }),
        this.prisma.outboxEvent.count({ where: { status: OutboxStatus.PENDING } }),
        this.prisma.stockReservation.count({
          where: { status: ReservationStatus.HELD, expiresAt: { lt: now } },
        }),
      ]);

    return {
      onayBekleyen,
      kuyruktaBekleyen,
      iletilemeyen,
      bekleyenOlay,
      suresiDolmusRezervasyon,
      timestamp: now.toISOString(),
    };
  }
}
