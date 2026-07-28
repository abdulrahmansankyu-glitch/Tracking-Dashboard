import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ description: 'Email address or 10-digit mobile number', example: 'owner@intoto.in' })
  @IsString() @MaxLength(150)
  @Transform(({ value }) => String(value ?? '').trim().toLowerCase())
  identifier!: string;

  @ApiProperty({ example: 'Owner@12345' })
  @IsString() @MaxLength(200)
  password!: string;

  @ApiPropertyOptional({ description: '6-digit TOTP code, required when 2FA is enabled' })
  @IsOptional() @IsString() @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from your authenticator app' })
  twoFactorCode?: string;

  @ApiPropertyOptional({ default: false, description: 'Issues a longer-lived refresh token' })
  @IsOptional() @IsBoolean()
  rememberMe?: boolean;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  refreshToken!: string;
}

/**
 * Password policy. Length carries most of the strength, but shop staff pick
 * "intoto123" without the character-class rules, so both are enforced.
 */
export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  currentPassword!: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10, { message: 'Password must be at least 10 characters' })
  @MaxLength(200)
  @Matches(/[a-z]/, { message: 'Include a lowercase letter' })
  @Matches(/[A-Z]/, { message: 'Include an uppercase letter' })
  @Matches(/\d/, { message: 'Include a number' })
  @Matches(/[^A-Za-z0-9]/, { message: 'Include a symbol' })
  newPassword!: string;
}

export class VerifyTwoFactorDto {
  @ApiProperty({ description: '6-digit code from the authenticator app' })
  @IsString() @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code' })
  code!: string;
}

export class AuthTokensDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty() refreshToken!: string;
  @ApiProperty({ description: 'Access token lifetime in seconds' }) expiresIn!: number;
  @ApiProperty() user!: {
    id: string;
    name: string;
    email: string;
    roles: string[];
    permissions: string[];
    shops: Array<{ id: string; name: string; code: string }>;
    organization: { id: string; name: string; currency: string };
    twoFactorEnabled: boolean;
    mustChangePassword: boolean;
  };
}

/** Returned when credentials are valid but a TOTP code is still required. */
export class TwoFactorRequiredDto {
  @ApiProperty({ default: true }) twoFactorRequired!: boolean;
  @ApiProperty() message!: string;
}
