import type { Permission, RoleName } from '@intoto/shared';

/**
 * The authenticated caller, attached to every request by the JWT guard and read by
 * guards, services and the audit interceptor.
 */
export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  roles: RoleName[];
  permissions: Permission[];
  /**
   * Shops this user may act on. An empty array means "every shop in the organization" —
   * that is how OWNER and ADMIN are represented, and it is why shop scoping must always
   * be checked via `canAccessShop` rather than by testing array membership directly.
   */
  shopIds: string[];
  /** Shop selected in the UI for this request, when the client sent one */
  activeShopId?: string;
  employeeId?: string;
}

export interface RequestContext {
  user: AuthenticatedUser;
  correlationId: string;
  ipAddress?: string;
  userAgent?: string;
}

/** Does this user have rights over `shopId`? An empty shop list means all shops. */
export function canAccessShop(user: AuthenticatedUser, shopId: string): boolean {
  return user.shopIds.length === 0 || user.shopIds.includes(shopId);
}

/**
 * Shop filter to merge into a Prisma `where`.
 * Returns `{}` for org-wide users so their queries are not needlessly constrained.
 */
export function shopScopeWhere(
  user: AuthenticatedUser,
  requestedShopId?: string,
): { shopId?: string | { in: string[] } } {
  if (requestedShopId) {
    return { shopId: requestedShopId };
  }
  if (user.shopIds.length === 0) {
    return {};
  }
  return { shopId: { in: user.shopIds } };
}
