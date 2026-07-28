import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasPermission, type Permission } from '@intoto/shared';

import { PERMISSIONS_KEY } from '../decorators';
import type { AuthenticatedUser } from '../context/request-context';

/**
 * Enforces `@RequirePermissions(...)`. Runs after JwtAuthGuard, so `request.user` is
 * populated. Missing permissions produce a message naming what was needed — support
 * calls about "access denied" are otherwise unanswerable.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) throw new ForbiddenException('Authentication required');

    const missing = required.filter((permission) => !hasPermission(user.permissions, permission));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Your role does not allow this action. Missing permission: ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
