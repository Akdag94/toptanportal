/**
 * ToptanPortal - Hiz Sinirlama Muhafizi
 *
 * GDD Bolum 5: "Rakip firmalarin botlarla portala girip toptan fiyatlari ve
 * stok durumlarini kazimasini engellemek icin ... kati Rate Limiting."
 *
 * Cloudflare ag sinirinda kaba filtreyi yapar; bu muhafiz uc nokta bazinda
 * ince ayarli ikinci katmandir. Ozellikle giris ve MFA uc noktalarinda
 * kaba kuvvet saldirilarini durdurur.
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ErrorCode } from '@toptanportal/contracts';

import { getRequestContext } from '../context/request-context';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../decorators';
import { ApiException } from '../exceptions/api.exception';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!options) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestContext = getRequestContext();

    const scope = options.scope ?? 'IP';
    const identifier = this.buildIdentifier(scope, options, request);
    const endpoint = `${request.method}:${context.getClass().name}.${context.getHandler().name}`;
    const key = `ratelimit:${endpoint}:${identifier}`;

    const result = await this.redis.consumeRateLimit(
      key,
      options.limit,
      options.windowSeconds,
    );

    response.setHeader('X-RateLimit-Limit', options.limit);
    response.setHeader('X-RateLimit-Remaining', result.remaining);
    response.setHeader('X-RateLimit-Reset', result.resetAfterSeconds);

    if (!result.allowed) {
      response.setHeader('Retry-After', result.resetAfterSeconds);
      throw ApiException.tooManyRequests(
        ErrorCode.RATE_LIMITED,
        `Çok fazla istek gönderdiniz. Lütfen ${result.resetAfterSeconds} saniye sonra tekrar deneyin.`,
      );
    }

    void requestContext;
    return true;
  }

  private buildIdentifier(
    scope: NonNullable<RateLimitOptions['scope']>,
    options: RateLimitOptions,
    request: Request,
  ): string {
    const context = getRequestContext();
    const ip = context?.ip ?? 'bilinmeyen';

    if (scope === 'USER') {
      return context?.principal?.userId ?? `ip:${ip}`;
    }

    if (scope === 'IP_TARGET') {
      const field = options.targetField ?? 'email';
      const body = request.body as Record<string, unknown> | undefined;
      const rawTarget = body?.[field];
      const target =
        typeof rawTarget === 'string' && rawTarget.length > 0
          ? rawTarget.trim().toLowerCase().slice(0, 254)
          : 'hedefsiz';
      return `${ip}|${target}`;
    }

    return ip;
  }
}
