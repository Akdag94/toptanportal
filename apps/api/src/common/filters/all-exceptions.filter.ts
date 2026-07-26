/**
 * ToptanPortal - Kuresel Hata Filtresi
 *
 * Tum hatalari tek bir sozlesmeye indirger ve ic detaylarin (SQL, dosya yolu,
 * yigin izi) istemciye sizmasini engeller. Sunucu tarafinda ise tam ayrinti
 * requestId ile loglanir; destek talebinde bu kimlik uzerinden eslesme yapilir.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@toptanportal/db';
import { ERROR_MESSAGES, ErrorCode, type ApiErrorBody } from '@toptanportal/contracts';

import { getRequestContext } from '../context/request-context';
import { ApiException } from '../exceptions/api.exception';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const context = getRequestContext();
    const requestId = context?.requestId ?? 'bilinmeyen';

    const resolved = this.resolve(exception);

    const body: ApiErrorBody = {
      statusCode: resolved.status,
      code: resolved.code,
      message: resolved.message,
      requestId,
      timestamp: new Date().toISOString(),
    };

    if (resolved.details) {
      body.details = resolved.details;
    }

    if (resolved.context) {
      body.context = resolved.context;
    }

    const logLine =
      `${request.method} ${request.originalUrl} -> ${resolved.status} ${resolved.code} ` +
      `[requestId=${requestId}] [ip=${context?.ip ?? '-'}] ` +
      `[user=${context?.principal?.userId ?? 'anonim'}]`;

    if (resolved.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${logLine} :: ${resolved.internalMessage}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (resolved.status === HttpStatus.TOO_MANY_REQUESTS || resolved.status === HttpStatus.FORBIDDEN) {
      this.logger.warn(`${logLine} :: ${resolved.internalMessage}`);
    } else {
      this.logger.debug(`${logLine} :: ${resolved.internalMessage}`);
    }

    if (response.headersSent) return;
    response.status(resolved.status).json(body);
  }

  private resolve(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: Record<string, string[]>;
    context?: Record<string, unknown>;
    internalMessage: string;
  } {
    if (exception instanceof ApiException) {
      const payload = exception.getResponse() as { message?: string };
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: payload.message ?? ERROR_MESSAGES[exception.code],
        details: exception.details,
        context: exception.context,
        internalMessage: payload.message ?? exception.code,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.resolvePrismaError(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: ErrorCode.VALIDATION_FAILED,
        message: ERROR_MESSAGES.VALIDATION_FAILED,
        internalMessage: exception.message,
      };
    }

    if (exception instanceof Prisma.PrismaClientInitializationError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Servise şu anda ulaşılamıyor. Lütfen kısa bir süre sonra tekrar deneyin.',
        internalMessage: exception.message,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const message =
        typeof raw === 'string'
          ? raw
          : ((raw as { message?: string | string[] }).message ?? exception.message);

      return {
        status,
        code: mapStatusToErrorCode(status),
        message: Array.isArray(message) ? (message[0] ?? 'Geçersiz istek.') : message,
        internalMessage: exception.message,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: ERROR_MESSAGES.INTERNAL_ERROR,
      internalMessage: exception instanceof Error ? exception.message : String(exception),
    };
  }

  private resolvePrismaError(error: Prisma.PrismaClientKnownRequestError): {
    status: number;
    code: ErrorCode;
    message: string;
    internalMessage: string;
  } {
    switch (error.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.CONFLICT,
          message: 'Bu kayıt zaten mevcut.',
          internalMessage: `Benzersizlik ihlali: ${JSON.stringify(error.meta ?? {})}`,
        };
      case 'P2003':
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.CONFLICT,
          message: 'İlişkili kayıt bulunduğu için işlem tamamlanamadı.',
          internalMessage: `Yabancı anahtar ihlali: ${JSON.stringify(error.meta ?? {})}`,
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          code: ErrorCode.RESOURCE_NOT_FOUND,
          message: ERROR_MESSAGES.RESOURCE_NOT_FOUND,
          internalMessage: `Kayıt bulunamadı: ${JSON.stringify(error.meta ?? {})}`,
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ErrorCode.INTERNAL_ERROR,
          message: ERROR_MESSAGES.INTERNAL_ERROR,
          internalMessage: `Prisma ${error.code}: ${error.message}`,
        };
    }
  }
}

function mapStatusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ErrorCode.VALIDATION_FAILED;
    case HttpStatus.UNAUTHORIZED:
      return ErrorCode.SESSION_EXPIRED;
    case HttpStatus.FORBIDDEN:
      return ErrorCode.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCode.RESOURCE_NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ErrorCode.CONFLICT;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ErrorCode.RATE_LIMITED;
    case HttpStatus.SERVICE_UNAVAILABLE:
      return ErrorCode.LOGO_UNAVAILABLE;
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}
