/**
 * ToptanPortal API - Giris Noktasi
 */

import 'reflect-metadata';
import { Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
  });

  const config = app.get(ConfigService).getOrThrow<AppConfig>('app');
  const isProduction = config.NODE_ENV === 'production';

  // Cloudflare -> yuk dengeleyici -> uygulama zinciri icin
  app.set('trust proxy', config.TRUST_CLOUDFLARE_HEADERS ? 1 : false);

  app.use(
    helmet({
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
      hsts: isProduction
        ? { maxAge: 63072000, includeSubDomains: true, preload: true }
        : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  app.enableCors({
    origin: [config.WEB_BASE_URL],
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-Tenant-Code',
      'Idempotency-Key',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ],
    maxAge: 600,
  });

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Kaba kuvvet ve kazima girisimlerinde govde boyutu da sinirlanir.
  app.useBodyParser('json', { limit: '1mb' });

  /* Banka sanal POS'lari geri donusu FORM olarak gonderir (application/
     x-www-form-urlencoded), JSON degil. Bu ayristirici olmadan POS yaniti bos
     govdeyle gelir ve her odeme "işlem bulunamadı" ile biter. */
  app.useBodyParser('urlencoded', { limit: '256kb', extended: false });

  if (!isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('ToptanPortal API')
        .setDescription(
          'HoReCa B2B e-ticaret ve müşteri portalı. Tüm uç noktalar rol bazlı ' +
            'yetkilendirmeye tabidir; İşletme Alt Yetkilisi rolünde finansal alanlar ' +
            'yanıttan tamamen çıkarılır (Kör Sipariş Modu).',
        )
        .setVersion('1.0')
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
    logger.log(`API dokümantasyonu: ${config.API_BASE_URL}/api/docs`);
  }

  app.enableShutdownHooks();

  await app.listen(config.API_PORT, '0.0.0.0');
  logger.log(`ToptanPortal API ${config.API_PORT} portunda çalışıyor (${config.NODE_ENV}).`);
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nAPI başlatılamadı: ${message}\n`);
  process.exit(1);
});
