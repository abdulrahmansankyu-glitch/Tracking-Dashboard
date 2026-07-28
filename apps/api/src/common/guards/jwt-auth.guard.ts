import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from '../decorators';
import type { AuthenticatedUser } from '../context/request-context';

export interface AccessTokenPayload {
  sub: string;
  organizationId: string;
  name: string;
  email: string;
  roles: AuthenticatedUser['roles'];
  permissions: AuthenticatedUser['permissions'];
  shopIds: string[];
  employeeId?: string;
}

/**
 * Verifies the bearer token and attaches the caller to the request.
 *
 * Permissions are carried inside the token rather than re-read from the database on
 * every call — that keeps the POS fast. The cost is that a permission change takes
 * effect on the next token refresh (15 minutes by default); `AuthService.revokeUser`
 * forces it to be immediate when an account is suspended.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: this.configService.getOrThrow<string>('jwt.accessSecret'),
      });
    } catch {
      throw new UnauthorizedException('Session expired — please sign in again');
    }

    const activeShopHeader = request.headers['x-shop-id'];
    request.user = {
      id: payload.sub,
      organizationId: payload.organizationId,
      name: payload.name,
      email: payload.email,
      roles: payload.roles ?? [],
      permissions: payload.permissions ?? [],
      shopIds: payload.shopIds ?? [],
      employeeId: payload.employeeId,
      activeShopId: typeof activeShopHeader === 'string' ? activeShopHeader : undefined,
    };
    return true;
  }

  private extractToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);
    // Cookie fallback lets the Next.js server components call the API without
    // re-plumbing the Authorization header through every fetch.
    const cookie = (request as unknown as { cookies?: Record<string, string> }).cookies;
    return cookie?.access_token;
  }
}
