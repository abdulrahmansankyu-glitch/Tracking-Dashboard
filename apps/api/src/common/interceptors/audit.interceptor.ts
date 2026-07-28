import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditAction } from '@prisma/client';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';

import { AUDIT_KEY, SKIP_AUDIT_KEY, type AuditConfig } from '../decorators';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../context/request-context';

const METHOD_TO_ACTION: Record<string, AuditAction> = {
  POST: AuditAction.CREATE,
  PUT: AuditAction.UPDATE,
  PATCH: AuditAction.UPDATE,
  DELETE: AuditAction.DELETE,
};

/**
 * Writes an AuditLog row for every successful mutation on a route carrying `@Audit()`.
 *
 * Two deliberate choices:
 *
 *  - Only mutations are logged by default. Logging every GET would bury the signal and
 *    grow the table by millions of rows a month; routes that expose sensitive data opt
 *    in explicitly with `@Audit({ action: 'VIEW_SENSITIVE' })`.
 *  - Failures are swallowed. An audit write must never turn a completed sale into an
 *    error for the cashier — it is logged loudly instead and reconciled by the ops job.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const config = this.reflector.getAllAndOverride<AuditConfig>(AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip || !config) return next.handle();

    const request = context.switchToHttp().getRequest<
      Request & { user?: AuthenticatedUser; correlationId?: string }
    >();
    const method = request.method.toUpperCase();
    const action = (config.action as AuditAction | undefined) ?? METHOD_TO_ACTION[method];
    if (!action) return next.handle();

    return next.handle().pipe(
      tap((response) => {
        void this.write(request, config, action, response);
      }),
    );
  }

  private async write(
    request: Request & { user?: AuthenticatedUser; correlationId?: string },
    config: AuditConfig,
    action: AuditAction,
    response: unknown,
  ): Promise<void> {
    const user = request.user;
    if (!user) return;

    try {
      const record = this.unwrap(response);
      const entityId =
        (record?.id as string | undefined) ?? (request.params?.id as string | undefined);
      const entityLabel = config.labelField
        ? (record?.[config.labelField] as string | undefined)
        : undefined;
      const body = request.body as Record<string, unknown> | undefined;

      await this.prisma.auditLog.create({
        data: {
          organizationId: user.organizationId,
          userId: user.id,
          userName: user.name,
          action,
          entityType: config.entityType,
          entityId: entityId ?? null,
          entityLabel: entityLabel ?? null,
          shopId:
            (request.query?.shopId as string | undefined) ??
            (body?.shopId as string | undefined) ??
            user.activeShopId ??
            null,
          // The submitted payload is the change set. Field-level before/after diffs are
          // produced by BaseCrudService, which has the previous row in hand; this is the
          // fallback for routes that do not go through it.
          changes: body ? (this.redact(body) as object) : undefined,
          ipAddress: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
          correlationId: request.correlationId ?? null,
          reason: (body?.reason as string | undefined) ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit log for ${config.entityType}: ${(error as Error).message}`,
      );
    }
  }

  /** Controllers may return the record directly or wrapped in `{ data }`. */
  private unwrap(response: unknown): Record<string, unknown> | undefined {
    if (!response || typeof response !== 'object') return undefined;
    const candidate = response as Record<string, unknown>;
    if (candidate.data && typeof candidate.data === 'object' && !Array.isArray(candidate.data)) {
      return candidate.data as Record<string, unknown>;
    }
    return candidate;
  }

  /** Never let a password, token or PIN reach the audit table. */
  private redact(body: Record<string, unknown>): Record<string, unknown> {
    const SENSITIVE = [
      'password', 'newPassword', 'currentPassword', 'confirmPassword',
      'token', 'refreshToken', 'accessToken', 'twoFactorSecret', 'pin', 'pinHash',
      'bankAccountNumber', 'secret',
    ];
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      output[key] = SENSITIVE.includes(key) ? '[REDACTED]' : value;
    }
    return output;
  }
}
