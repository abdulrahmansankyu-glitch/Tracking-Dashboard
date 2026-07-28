import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { canAccessShop, type AuthenticatedUser } from '../context/request-context';

/**
 * Stops a branch manager from reading or writing another branch's data.
 *
 * Permission answers "may this action happen at all"; this guard answers "may it happen
 * *here*". Any request carrying an explicit shopId is checked against the user's
 * assigned shops. Requests without one are left to the service layer, which applies
 * `shopScopeWhere` so a list endpoint returns only permitted shops rather than failing.
 */
@Injectable()
export class ShopScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
      query?: Record<string, unknown>;
      body?: Record<string, unknown>;
      params?: Record<string, unknown>;
    }>();

    const user = request.user;
    if (!user) return true; // public route, or JwtAuthGuard already rejected it

    const candidates = [
      request.params?.shopId,
      request.query?.shopId,
      request.body?.shopId,
      // Stock transfers name their shops explicitly; both ends must be permitted.
      request.body?.fromShopId,
      request.body?.toShopId,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    for (const shopId of candidates) {
      if (!canAccessShop(user, shopId)) {
        throw new ForbiddenException('You do not have access to this shop');
      }
    }
    return true;
  }
}
