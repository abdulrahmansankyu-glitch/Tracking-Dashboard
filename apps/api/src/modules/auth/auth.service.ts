import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuditAction, UserStatus } from '@prisma/client';
import { resolveEffectivePermissions, type Permission, type RoleName } from '@intoto/shared';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';

import { PrismaService } from '../../common/prisma/prisma.service';
import { CryptoService } from '../../common/security/crypto.service';
import type { AuthenticatedUser } from '../../common/context/request-context';
import type { AccessTokenPayload } from '../../common/guards/jwt-auth.guard';
import type { AuthTokensDto } from './dto/auth.dto';

interface LoginContext {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly crypto: CryptoService,
  ) {}

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  /**
   * Authenticate by email or mobile.
   *
   * Every failure path returns the same message and takes a comparable amount of time
   * (the bcrypt compare runs even for an unknown user), so the response cannot be used
   * to enumerate which accounts exist.
   */
  async login(
    identifier: string,
    password: string,
    twoFactorCode: string | undefined,
    context: LoginContext,
  ): Promise<AuthTokensDto | { twoFactorRequired: true; message: string }> {
    const user = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [{ email: identifier }, { phone: identifier.replace(/\D/g, '').slice(-10) }],
      },
      include: {
        roles: { include: { role: true } },
        shopAccess: { include: { shop: { select: { id: true, name: true, code: true } } } },
        organization: { select: { id: true, name: true, currency: true } },
        employee: { select: { id: true } },
      },
    });

    // Dummy hash keeps the timing of "no such user" close to "wrong password".
    const passwordHash = user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const passwordMatches = await bcrypt.compare(password, passwordHash);

    if (!user || !passwordMatches) {
      if (user) await this.registerFailedLogin(user.id, user.failedLoginCount, context);
      throw new UnauthorizedException('Incorrect email/mobile or password');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new ForbiddenException(
        `Account locked after too many failed attempts. Try again in ${minutes} minute(s).`,
      );
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('This account has been suspended. Contact the owner.');
    }
    if (user.status === UserStatus.INVITED) {
      throw new ForbiddenException('Please accept your invitation before signing in.');
    }

    // --- Two-factor ---
    if (user.twoFactorEnabled) {
      if (!twoFactorCode) {
        return {
          twoFactorRequired: true,
          message: 'Enter the 6-digit code from your authenticator app',
        };
      }
      const valid = await this.verifyTotp(user.id, twoFactorCode, user.twoFactorSecret, user.twoFactorBackupCodes);
      if (!valid) {
        await this.registerFailedLogin(user.id, user.failedLoginCount, context);
        throw new UnauthorizedException('That code is not valid or has expired');
      }
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        lastLoginIp: context.ipAddress ?? null,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    await this.writeAuthAudit(user.organizationId, user.id, user.name, AuditAction.LOGIN, context);

    return this.issueTokens(user, context);
  }

  private async registerFailedLogin(
    userId: string,
    currentCount: number,
    context: LoginContext,
  ): Promise<void> {
    const maxAttempts = this.configService.get<number>('security.maxFailedLogins') ?? 5;
    const lockoutMinutes = this.configService.get<number>('security.lockoutMinutes') ?? 15;
    const nextCount = currentCount + 1;

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: nextCount,
        lockedUntil:
          nextCount >= maxAttempts ? new Date(Date.now() + lockoutMinutes * 60_000) : undefined,
      },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { organizationId: true, name: true },
    });
    if (user) {
      await this.writeAuthAudit(
        user.organizationId,
        userId,
        user.name,
        AuditAction.LOGIN_FAILED,
        context,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  private async issueTokens(
    user: {
      id: string;
      organizationId: string;
      name: string;
      email: string;
      twoFactorEnabled: boolean;
      mustChangePassword: boolean;
      extraPermissions: string[];
      deniedPermissions: string[];
      roles: Array<{ role: { name: RoleName } }>;
      shopAccess: Array<{ shop: { id: string; name: string; code: string } }>;
      organization: { id: string; name: string; currency: string };
      employee: { id: string } | null;
    },
    context: LoginContext,
  ): Promise<AuthTokensDto> {
    const roles = user.roles.map((r) => r.role.name);
    const permissions = resolveEffectivePermissions({
      roles,
      extraGrants: user.extraPermissions as Permission[],
      denials: user.deniedPermissions as Permission[],
    });
    const shops = user.shopAccess.map((access) => access.shop);

    const payload: AccessTokenPayload = {
      sub: user.id,
      organizationId: user.organizationId,
      name: user.name,
      email: user.email,
      roles,
      permissions,
      // An empty list means "all shops" — see canAccessShop.
      shopIds: shops.map((shop) => shop.id),
      employeeId: user.employee?.id,
    };

    const accessTtl = this.configService.get<string>('jwt.accessTtl') ?? '15m';
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow<string>('jwt.accessSecret'),
      expiresIn: accessTtl,
    });

    // The refresh token is opaque, not a JWT: it must be revocable, and only its
    // SHA-256 is stored so a database leak cannot be replayed as a session.
    const refreshToken = this.crypto.randomToken(48);
    const refreshTtlDays = this.parseDays(this.configService.get<string>('jwt.refreshTtl') ?? '30d');

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.crypto.hash(refreshToken),
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
        expiresAt: new Date(Date.now() + refreshTtlDays * 86_400_000),
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.parseSeconds(accessTtl),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        roles,
        permissions,
        shops,
        organization: user.organization,
        twoFactorEnabled: user.twoFactorEnabled,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * The presented token is revoked as it is consumed (rotation). If a revoked token is
   * presented again, that means it was stolen and replayed, so every session for the
   * user is killed rather than just rejecting the one request.
   */
  async refresh(refreshToken: string, context: LoginContext): Promise<AuthTokensDto> {
    const tokenHash = this.crypto.hash(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            roles: { include: { role: true } },
            shopAccess: { include: { shop: { select: { id: true, name: true, code: true } } } },
            organization: { select: { id: true, name: true, currency: true } },
            employee: { select: { id: true } },
          },
        },
      },
    });

    if (!stored) {
      throw new UnauthorizedException('Session expired — please sign in again');
    }

    if (stored.revokedAt) {
      this.logger.warn(
        `Replay of a revoked refresh token for user ${stored.userId} — revoking all sessions`,
      );
      await this.revokeAllSessions(stored.userId);
      throw new UnauthorizedException('Session expired — please sign in again');
    }

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Session expired — please sign in again');
    }
    if (stored.user.deletedAt || stored.user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('This account is no longer active');
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(stored.user, context);
  }

  async logout(refreshToken: string | undefined, user: AuthenticatedUser): Promise<{ success: true }> {
    if (refreshToken) {
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash: this.crypto.hash(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await this.writeAuthAudit(user.organizationId, user.id, user.name, AuditAction.LOGOUT, {});
    return { success: true };
  }

  /** Kill every session for a user — on suspension, password change or token replay. */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // -------------------------------------------------------------------------
  // Profile & password
  // -------------------------------------------------------------------------

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        roles: { include: { role: true } },
        shopAccess: { include: { shop: { select: { id: true, name: true, code: true, stateCode: true } } } },
        organization: { select: { id: true, name: true, currency: true, gstin: true, stateCode: true } },
        employee: { select: { id: true, employeeCode: true, designation: true, shopId: true } },
      },
    });
    if (!user) throw new UnauthorizedException();

    const roles = user.roles.map((r) => r.role.name);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      roles,
      permissions: resolveEffectivePermissions({
        roles,
        extraGrants: user.extraPermissions as Permission[],
        denials: user.deniedPermissions as Permission[],
      }),
      shops: user.shopAccess.map((a) => a.shop),
      organization: user.organization,
      employee: user.employee,
      twoFactorEnabled: user.twoFactorEnabled,
      mustChangePassword: user.mustChangePassword,
      preferences: user.preferences,
      lastLoginAt: user.lastLoginAt,
    };
  }

  async changePassword(
    user: AuthenticatedUser,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ success: true }> {
    const record = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!record) throw new UnauthorizedException();

    if (!(await bcrypt.compare(currentPassword, record.passwordHash))) {
      throw new BadRequestException('Your current password is incorrect');
    }
    if (await bcrypt.compare(newPassword, record.passwordHash)) {
      throw new BadRequestException('The new password must be different from the current one');
    }

    const rounds = this.configService.get<number>('security.bcryptRounds') ?? 12;
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(newPassword, rounds),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
      },
    });

    // Other devices are now holding a credential the user just chose to invalidate.
    await this.revokeAllSessions(user.id);
    await this.writeAuthAudit(
      user.organizationId,
      user.id,
      user.name,
      AuditAction.PASSWORD_CHANGE,
      {},
    );
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Two-factor authentication
  // -------------------------------------------------------------------------

  /** Generate a secret and QR code. 2FA is not active until `confirmTwoFactor` succeeds. */
  async beginTwoFactorSetup(user: AuthenticatedUser): Promise<{
    secret: string;
    qrCodeDataUrl: string;
    otpauthUrl: string;
  }> {
    const secret = authenticator.generateSecret();
    const issuer = this.configService.get<string>('security.totpIssuer') ?? 'Intoto ERP';
    const otpauthUrl = authenticator.keyuri(user.email, issuer, secret);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: this.crypto.encrypt(secret) },
    });

    return {
      secret,
      qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl, { width: 240, margin: 1 }),
      otpauthUrl,
    };
  }

  /**
   * Confirm setup and switch 2FA on. Returns ten single-use backup codes — the only
   * time they are ever shown, since only their hashes are kept.
   */
  async confirmTwoFactor(user: AuthenticatedUser, code: string): Promise<{ backupCodes: string[] }> {
    const record = await this.prisma.user.findUnique({ where: { id: user.id } });
    const secret = this.crypto.decrypt(record?.twoFactorSecret);
    if (!secret) {
      throw new BadRequestException('Start two-factor setup before confirming it');
    }
    if (!authenticator.verify({ token: code, secret })) {
      throw new BadRequestException('That code is not valid. Check your device clock and try again.');
    }

    const backupCodes = Array.from({ length: 10 }, () =>
      this.crypto.randomToken(5).replace(/[-_]/g, '').slice(0, 8).toUpperCase(),
    );

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: true,
        twoFactorBackupCodes: backupCodes.map((c) => this.crypto.hash(c)),
      },
    });

    await this.writeAuthAudit(
      user.organizationId,
      user.id,
      user.name,
      AuditAction.TWO_FACTOR_ENABLED,
      {},
    );
    return { backupCodes };
  }

  async disableTwoFactor(user: AuthenticatedUser, password: string): Promise<{ success: true }> {
    const record = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!record || !(await bcrypt.compare(password, record.passwordHash))) {
      throw new BadRequestException('Password is incorrect');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: [] },
    });
    await this.writeAuthAudit(
      user.organizationId,
      user.id,
      user.name,
      AuditAction.TWO_FACTOR_DISABLED,
      {},
    );
    return { success: true };
  }

  /** Accepts either a live TOTP code or an unused backup code (which is then burned). */
  private async verifyTotp(
    userId: string,
    code: string,
    encryptedSecret: string | null,
    backupCodeHashes: string[],
  ): Promise<boolean> {
    const secret = this.crypto.decrypt(encryptedSecret);
    if (secret && authenticator.verify({ token: code, secret })) return true;

    const presentedHash = this.crypto.hash(code.toUpperCase());
    if (backupCodeHashes.includes(presentedHash)) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { twoFactorBackupCodes: backupCodeHashes.filter((h) => h !== presentedHash) },
      });
      this.logger.warn(`User ${userId} signed in with a backup code`);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async writeAuthAudit(
    organizationId: string,
    userId: string,
    userName: string,
    action: AuditAction,
    context: LoginContext,
  ): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          organizationId,
          userId,
          userName,
          action,
          entityType: 'User',
          entityId: userId,
          entityLabel: userName,
          ipAddress: context.ipAddress ?? null,
          userAgent: context.userAgent ?? null,
        },
      })
      .catch((error: Error) => {
        // Never let audit failure block a login.
        this.logger.error(`Auth audit write failed: ${error.message}`);
      });
  }

  private parseDays(ttl: string): number {
    const match = /^(\d+)([dhm])$/.exec(ttl);
    if (!match) return 30;
    const value = Number(match[1]);
    switch (match[2]) {
      case 'd': return value;
      case 'h': return value / 24;
      case 'm': return value / 1440;
      default: return 30;
    }
  }

  private parseSeconds(ttl: string): number {
    const match = /^(\d+)([dhms])$/.exec(ttl);
    if (!match) return 900;
    const value = Number(match[1]);
    switch (match[2]) {
      case 'd': return value * 86_400;
      case 'h': return value * 3_600;
      case 'm': return value * 60;
      case 's': return value;
      default: return 900;
    }
  }
}
