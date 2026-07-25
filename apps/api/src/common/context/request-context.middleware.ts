import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import type { AppConfig } from '../../config/configuration';
import { resolveClientNetwork } from '../net/ip.util';
import { runWithRequestContext, type RequestContext } from './request-context';

/** Istemcinin gonderdigi izleme kimligini kabul et, yoksa uret. */
const MAX_REQUEST_ID_LENGTH = 64;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly trustCloudflare: boolean;

  constructor(configService: ConfigService) {
    const config = configService.getOrThrow<AppConfig>('app');
    this.trustCloudflare = config.TRUST_CLOUDFLARE_HEADERS;
  }

  use(request: Request, response: Response, next: NextFunction): void {
    const network = resolveClientNetwork(
      request.headers,
      request.socket.remoteAddress,
      this.trustCloudflare,
    );

    const incomingId = request.header('x-request-id');
    const requestId =
      incomingId && REQUEST_ID_PATTERN.test(incomingId)
        ? incomingId.slice(0, MAX_REQUEST_ID_LENGTH)
        : randomUUID();

    const userAgent = request.header('user-agent') ?? null;

    const context: RequestContext = {
      requestId,
      ip: network.ip,
      country: network.country,
      city: network.city,
      userAgent: userAgent ? userAgent.slice(0, 512) : null,
      method: request.method,
      path: request.originalUrl.split('?')[0] ?? request.originalUrl,
      startedAt: Date.now(),
      principal: null,
    };

    response.setHeader('X-Request-Id', requestId);

    runWithRequestContext(context, () => {
      next();
    });
  }
}
