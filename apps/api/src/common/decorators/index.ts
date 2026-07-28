import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@intoto/shared';

import type { AuthenticatedUser } from '../context/request-context';

export const IS_PUBLIC_KEY = 'isPublic';
export const PERMISSIONS_KEY = 'requiredPermissions';
export const AUDIT_KEY = 'auditConfig';
export const SKIP_AUDIT_KEY = 'skipAudit';

/** Marks a route as reachable without authentication (login, health, webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Guards a route behind one or more permissions. All listed permissions are required.
 * @example @RequirePermissions('sale:create')
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export interface AuditConfig {
  /** Model name recorded in the audit trail, e.g. "SalesInvoice" */
  entityType: string;
  /** Overrides the action inferred from the HTTP method */
  action?: string;
  /** Field on the response used as the human-readable label, e.g. "invoiceNumber" */
  labelField?: string;
}

/** Declares what the audit interceptor should record for this route. */
export const Audit = (config: AuditConfig) => SetMetadata(AUDIT_KEY, config);

/** Opt a route out of audit logging (health checks, high-frequency reads). */
export const SkipAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);

/** Injects the authenticated user, or one of its fields. */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);

/** Injects the organization id of the caller — the tenant scope for every query. */
export const OrgId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
  return request.user?.organizationId;
});

/**
 * Injects the shop the request is acting on: the `shopId` query/body parameter when
 * present, otherwise the user's active shop from the `x-shop-id` header.
 */
export const ActiveShopId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<{
    user?: AuthenticatedUser;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  }>();
  return (
    request.query?.shopId ||
    (request.body?.shopId as string | undefined) ||
    request.headers?.['x-shop-id'] ||
    request.user?.activeShopId
  );
});

/** Injects the per-request correlation id used to tie logs and audit rows together. */
export const CorrelationId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<{ correlationId?: string }>();
  return request.correlationId;
});
