/**
 * ToptanPortal - Zod Dogrulama Boru Hatti
 *
 * Sozlesmeler (@toptanportal/contracts) hem API hem Web tarafinda ayni
 * semalarla dogrulanir. Bu boru hatti semayi uygular ve hatalari alan bazli,
 * Turkce ve istemci tarafindan islenebilir bicimde dondurur.
 */

import { Injectable, type PipeTransform } from '@nestjs/common';
import { ErrorCode } from '@toptanportal/contracts';
import { ZodError, type ZodSchema } from 'zod';

import { ApiException } from '../exceptions/api.exception';

@Injectable()
export class ZodValidationPipe<TOutput> implements PipeTransform<unknown, TOutput> {
  constructor(private readonly schema: ZodSchema<TOutput>) {}

  transform(value: unknown): TOutput {
    const result = this.schema.safeParse(value);

    if (result.success) {
      return result.data;
    }

    throw ApiException.unprocessable(
      ErrorCode.VALIDATION_FAILED,
      undefined,
      formatZodIssues(result.error),
    );
  }
}

export function formatZodIssues(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '_';
    const bucket = details[path];

    if (bucket) {
      bucket.push(issue.message);
    } else {
      details[path] = [issue.message];
    }
  }

  return details;
}

/** Kullanim: @Body(zodBody(loginRequestSchema)) body: LoginRequest */
export function zodBody<TOutput>(schema: ZodSchema<TOutput>): ZodValidationPipe<TOutput> {
  return new ZodValidationPipe(schema);
}
