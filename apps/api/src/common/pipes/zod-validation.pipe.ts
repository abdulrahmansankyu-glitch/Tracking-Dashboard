import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ZodError, type ZodTypeAny } from 'zod';

/**
 * Validates a request body against a Zod schema from `packages/shared`.
 *
 * The point is that the web form and the API validate with the *same* object, so a rule
 * change cannot leave the two disagreeing — the classic failure where a form accepts a
 * value the server then rejects with an unhelpful 400.
 *
 * Errors come back keyed by field path so the client can attach each message to its
 * input rather than dumping one string at the top of the form.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}

  transform(value: unknown): unknown {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        const details: Record<string, string[]> = {};
        for (const issue of error.errors) {
          const path = issue.path.join('.') || '_root';
          (details[path] ??= []).push(issue.message);
        }
        throw new BadRequestException({
          statusCode: 400,
          message: 'Please correct the highlighted fields',
          error: 'ValidationError',
          details,
        });
      }
      throw error;
    }
  }
}

/** Convenience for `@Body(zodBody(schema))`. */
export function zodBody(schema: ZodTypeAny): ZodValidationPipe {
  return new ZodValidationPipe(schema);
}
