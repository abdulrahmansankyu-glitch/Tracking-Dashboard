/**
 * Typed application configuration, loaded once at boot.
 * Anything read from process.env goes through here so a missing variable fails fast
 * at startup rather than at 11pm during billing.
 */

export interface AppConfig {
  env: string;
  port: number;
  apiPrefix: string;
  appName: string;
  appUrl: string;
  database: { url: string };
  redis: { url: string; host: string; port: number; password?: string };
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
  };
  security: {
    bcryptRounds: number;
    totpIssuer: string;
    fieldEncryptionKey: string;
    maxFailedLogins: number;
    lockoutMinutes: number;
  };
  storage: {
    driver: 'local' | 's3';
    localPath: string;
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  ai: {
    enabled: boolean;
    apiKey?: string;
    model: string;
    maxTokens: number;
  };
  notifications: {
    whatsapp: { enabled: boolean; phoneNumberId?: string; accessToken?: string };
    sms: { enabled: boolean; provider: string; apiKey?: string; senderId: string };
    email: {
      enabled: boolean;
      host?: string;
      port: number;
      user?: string;
      password?: string;
      from: string;
    };
  };
  india: {
    defaultStateCode: string;
    currency: string;
    timezone: string;
    financialYearStartMonth: number;
  };
  eInvoice: {
    enabled: boolean;
    baseUrl: string;
    clientId?: string;
    clientSecret?: string;
    username?: string;
    password?: string;
  };
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${key}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function bool(key: string, fallback = false): boolean {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

function int(key: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default (): AppConfig => ({
  env: optional('NODE_ENV', 'development'),
  // Managed hosts assign the port at runtime through PORT and route to it; listening on
  // anything else makes the service look dead to their health checks. API_PORT stays as
  // the local-development default.
  port: int('PORT', int('API_PORT', 4000)),
  apiPrefix: optional('API_PREFIX', 'api/v1'),
  appName: optional('APP_NAME', 'Intoto ERP'),
  appUrl: optional('APP_URL', 'http://localhost:3000'),

  database: { url: required('DATABASE_URL') },

  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
    host: optional('REDIS_HOST', 'localhost'),
    port: int('REDIS_PORT', 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessTtl: optional('JWT_ACCESS_TTL', '15m'),
    refreshTtl: optional('JWT_REFRESH_TTL', '30d'),
  },

  security: {
    bcryptRounds: int('BCRYPT_ROUNDS', 12),
    totpIssuer: optional('TOTP_ISSUER', 'Intoto ERP'),
    fieldEncryptionKey: optional('FIELD_ENCRYPTION_KEY'),
    maxFailedLogins: int('MAX_FAILED_LOGINS', 5),
    lockoutMinutes: int('LOCKOUT_MINUTES', 15),
  },

  storage: {
    driver: (optional('STORAGE_DRIVER', 'local') as 'local' | 's3'),
    localPath: optional('STORAGE_LOCAL_PATH', './storage'),
    bucket: optional('AWS_S3_BUCKET', 'intoto-erp-documents'),
    region: optional('AWS_REGION', 'ap-south-1'),
    endpoint: process.env.AWS_S3_ENDPOINT || undefined,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || undefined,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || undefined,
  },

  ai: {
    enabled: bool('AI_ENABLED', true),
    apiKey: process.env.ANTHROPIC_API_KEY || undefined,
    model: optional('ANTHROPIC_MODEL', 'claude-sonnet-5'),
    maxTokens: int('AI_MAX_TOKENS', 4096),
  },

  notifications: {
    whatsapp: {
      enabled: bool('WHATSAPP_ENABLED'),
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || undefined,
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN || undefined,
    },
    sms: {
      enabled: bool('SMS_ENABLED'),
      provider: optional('SMS_PROVIDER', 'msg91'),
      apiKey: process.env.SMS_API_KEY || undefined,
      senderId: optional('SMS_SENDER_ID', 'INTOTO'),
    },
    email: {
      enabled: bool('EMAIL_ENABLED'),
      host: process.env.SMTP_HOST || undefined,
      port: int('SMTP_PORT', 587),
      user: process.env.SMTP_USER || undefined,
      password: process.env.SMTP_PASSWORD || undefined,
      from: optional('SMTP_FROM', 'Intoto ERP <noreply@intoto.example>'),
    },
  },

  india: {
    defaultStateCode: optional('DEFAULT_STATE_CODE', '09'),
    currency: optional('DEFAULT_CURRENCY', 'INR'),
    timezone: optional('DEFAULT_TIMEZONE', 'Asia/Kolkata'),
    financialYearStartMonth: int('FINANCIAL_YEAR_START_MONTH', 4),
  },

  eInvoice: {
    enabled: bool('EINVOICE_ENABLED'),
    baseUrl: optional('EINVOICE_BASE_URL', 'https://einv-apisandbox.nic.in'),
    clientId: process.env.EINVOICE_CLIENT_ID || undefined,
    clientSecret: process.env.EINVOICE_CLIENT_SECRET || undefined,
    username: process.env.EINVOICE_USERNAME || undefined,
    password: process.env.EINVOICE_PASSWORD || undefined,
  },
});
