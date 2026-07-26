import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_MESSAGES, type ErrorCode } from '@toptanportal/contracts';

/**
 * Tum uygulama hatalarinin ortak tasiyicisi.
 * Istemciler mesaja degil `code` alanina gore dallanir.
 *
 * `details` alan bazli dogrulama hatalarini, `context` ise hataya ozgu yapisal
 * veriyi tasir (ornek: stok yetersizliginde eksik urun listesi).
 */
export class ApiException extends HttpException {
  readonly code: ErrorCode;
  readonly details?: Record<string, string[]>;
  readonly context?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    status: HttpStatus,
    message?: string,
    details?: Record<string, string[]>,
    context?: Record<string, unknown>,
  ) {
    super({ code, message: message ?? ERROR_MESSAGES[code] }, status);
    this.code = code;
    this.details = details;
    this.context = context;
  }

  static badRequest(code: ErrorCode, message?: string, details?: Record<string, string[]>) {
    return new ApiException(code, HttpStatus.BAD_REQUEST, message, details);
  }

  static unauthorized(code: ErrorCode, message?: string) {
    return new ApiException(code, HttpStatus.UNAUTHORIZED, message);
  }

  static forbidden(code: ErrorCode, message?: string) {
    return new ApiException(code, HttpStatus.FORBIDDEN, message);
  }

  static notFound(code: ErrorCode, message?: string) {
    return new ApiException(code, HttpStatus.NOT_FOUND, message);
  }

  static conflict(code: ErrorCode, message?: string) {
    return new ApiException(code, HttpStatus.CONFLICT, message);
  }

  static tooManyRequests(code: ErrorCode, message?: string) {
    return new ApiException(code, HttpStatus.TOO_MANY_REQUESTS, message);
  }

  static unprocessable(
    code: ErrorCode,
    message?: string,
    details?: Record<string, string[]>,
    context?: Record<string, unknown>,
  ) {
    return new ApiException(code, HttpStatus.UNPROCESSABLE_ENTITY, message, details, context);
  }

  static serviceUnavailable(code: ErrorCode, message?: string) {
    return new ApiException(code, HttpStatus.SERVICE_UNAVAILABLE, message);
  }

  static internal(code: ErrorCode, message?: string) {
    return new ApiException(code, HttpStatus.INTERNAL_SERVER_ERROR, message);
  }
}
