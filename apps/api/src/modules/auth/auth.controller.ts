import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { CurrentUser, Public, SkipAudit } from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/context/request-context';
import { AuthService } from './auth.service';
import {
  AuthTokensDto,
  ChangePasswordDto,
  LoginDto,
  RefreshDto,
  VerifyTwoFactorDto,
} from './dto/auth.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Public()
  @SkipAudit() // AuthService writes richer LOGIN / LOGIN_FAILED entries itself
  @HttpCode(HttpStatus.OK)
  // Tight limit: this is the endpoint credential-stuffing tools aim at.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sign in with email or mobile' })
  @ApiResponse({ status: 200, type: AuthTokensDto })
  login(@Body() dto: LoginDto, @Req() request: Request) {
    return this.authService.login(dto.identifier, dto.password, dto.twoFactorCode, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }

  @Post('refresh')
  @Public()
  @SkipAudit()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Exchange a refresh token for a new token pair' })
  refresh(@Body() dto: RefreshDto, @Req() request: Request) {
    return this.authService.refresh(dto.refreshToken, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }

  @Post('logout')
  @ApiBearerAuth()
  @SkipAudit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke the current session' })
  logout(@Body() dto: Partial<RefreshDto>, @CurrentUser() user: AuthenticatedUser) {
    return this.authService.logout(dto.refreshToken, user);
  }

  @Get('me')
  @ApiBearerAuth()
  @SkipAudit()
  @ApiOperation({ summary: 'Current user, roles, permissions and accessible shops' })
  me(@CurrentUser('id') userId: string) {
    return this.authService.me(userId);
  }

  @Post('change-password')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @ApiOperation({ summary: 'Change password — revokes all other sessions' })
  changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() user: AuthenticatedUser) {
    return this.authService.changePassword(user, dto.currentPassword, dto.newPassword);
  }

  @Post('2fa/setup')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Begin 2FA setup — returns a QR code to scan' })
  beginTwoFactor(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.beginTwoFactorSetup(user);
  }

  @Post('2fa/confirm')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm 2FA — returns one-time backup codes' })
  confirmTwoFactor(@Body() dto: VerifyTwoFactorDto, @CurrentUser() user: AuthenticatedUser) {
    return this.authService.confirmTwoFactor(user, dto.code);
  }

  @Post('2fa/disable')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Turn 2FA off — requires the account password' })
  disableTwoFactor(
    @Body() body: { password: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.authService.disableTwoFactor(user, body.password);
  }
}
