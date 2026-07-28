import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';

/**
 * Turns every thrown value into the same JSON envelope, and translates database and
 * validation errors into messages a shop manager can act on.
 *
 * "Unique constraint failed on the fields: (`sku`)" is meaningless at the counter;
 * "A product with this SKU already exists" is not.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { correlationId?: string }>();

    const { status, message, error, details } = this.translate(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} → ${status}: ${message}`);
    }

    response.status(status).json({
      statusCode: status,
      message,
      error,
      details,
      correlationId: request.correlationId,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }

  private translate(exception: unknown): {
    status: number;
    message: string;
    error?: string;
    details?: Record<string, string[]>;
  } {
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        return { status: exception.getStatus(), message: payload };
      }
      const record = payload as Record<string, unknown>;
      const rawMessage = record.message;
      return {
        status: exception.getStatus(),
        message: Array.isArray(rawMessage) ? rawMessage.join('; ') : String(rawMessage ?? exception.message),
        error: record.error as string | undefined,
        details: this.groupValidationMessages(rawMessage),
      };
    }

    if (exception instanceof ZodError) {
      const details: Record<string, string[]> = {};
      for (const issue of exception.errors) {
        const path = issue.path.join('.') || '_root';
        (details[path] ??= []).push(issue.message);
      }
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'Please correct the highlighted fields',
        error: 'ValidationError',
        details,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.translatePrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'The request did not match what the database expects',
        error: 'PrismaValidationError',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Something went wrong. The technical team has been notified.',
      error: 'InternalServerError',
    };
  }

  private translatePrisma(exception: Prisma.PrismaClientKnownRequestError): {
    status: number;
    message: string;
    error: string;
    details?: Record<string, string[]>;
  } {
    const target = (exception.meta?.target as string[] | undefined)?.join(', ');
    switch (exception.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          message: target
            ? `A record with this ${this.humanise(target)} already exists`
            : 'This record already exists',
          error: 'DuplicateRecord',
          details: target ? { [target]: ['Must be unique'] } : undefined,
        };
      case 'P2003':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'A linked record referenced here does not exist',
          error: 'ForeignKeyViolation',
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          message: 'The requested record was not found',
          error: 'NotFound',
        };
      case 'P2014':
        return {
          status: HttpStatus.CONFLICT,
          message:
            'This record is still used elsewhere. Archive it instead of deleting, or remove the linked records first.',
          error: 'RelationViolation',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'A database error occurred',
          error: `Prisma${exception.code}`,
        };
    }
  }

  private groupValidationMessages(message: unknown): Record<string, string[]> | undefined {
    if (!Array.isArray(message)) return undefined;
    const details: Record<string, string[]> = {};
    for (const entry of message as string[]) {
      const field = entry.split(' ')[0] ?? '_root';
      (details[field] ??= []).push(entry);
    }
    return details;
  }

  private humanise(field: string): string {
    return field
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .trim()
      .toLowerCase();
  }
}
