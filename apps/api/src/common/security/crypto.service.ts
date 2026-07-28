import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Field-level encryption for the data that would hurt most if the database leaked:
 * supplier bank account numbers, TOTP secrets, gift card PINs.
 *
 * AES-256-GCM, which authenticates as well as encrypts — a tampered ciphertext fails to
 * decrypt rather than silently returning wrong bytes. Ciphertext is stored as
 * `v1:<iv>:<authTag>:<data>`, all base64; the version prefix means the key or algorithm
 * can be rotated later without a migration that has to guess at the old format.
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly key: Buffer | null;
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly VERSION = 'v1';

  constructor(private readonly configService: ConfigService) {
    const raw = this.configService.get<string>('security.fieldEncryptionKey');
    if (!raw) {
      this.key = null;
      // Loud, because running production without this means bank details sit in plaintext.
      this.logger.warn(
        'FIELD_ENCRYPTION_KEY is not set — sensitive fields will be stored unencrypted. ' +
          'Generate one with: openssl rand -base64 32',
      );
      return;
    }
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length !== 32) {
      throw new Error('FIELD_ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32)');
    }
    this.key = decoded;
  }

  get isEnabled(): boolean {
    return this.key !== null;
  }

  encrypt(plaintext: string | null | undefined): string | null {
    if (plaintext === null || plaintext === undefined || plaintext === '') return null;
    if (!this.key) return plaintext;

    const iv = randomBytes(12);
    const cipher = createCipheriv(CryptoService.ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      CryptoService.VERSION,
      iv.toString('base64'),
      authTag.toString('base64'),
      encrypted.toString('base64'),
    ].join(':');
  }

  decrypt(ciphertext: string | null | undefined): string | null {
    if (!ciphertext) return null;
    if (!this.key) return ciphertext;
    // Values written before encryption was switched on stay readable.
    if (!ciphertext.startsWith(`${CryptoService.VERSION}:`)) return ciphertext;

    try {
      const [, ivB64, tagB64, dataB64] = ciphertext.split(':');
      if (!ivB64 || !tagB64 || !dataB64) return null;

      const decipher = createDecipheriv(
        CryptoService.ALGORITHM,
        this.key,
        Buffer.from(ivB64, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      this.logger.error(`Failed to decrypt a field: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Mask an account number for display: 123456789012 → XXXXXXXX9012.
   * Shown by default everywhere; the full value requires `supplier:read` plus an
   * explicit reveal that is itself audited as VIEW_SENSITIVE.
   */
  mask(value: string | null | undefined, visibleSuffix = 4): string | null {
    if (!value) return null;
    if (value.length <= visibleSuffix) return 'X'.repeat(value.length);
    return 'X'.repeat(value.length - visibleSuffix) + value.slice(-visibleSuffix);
  }

  /** SHA-256, used for refresh-token lookup where the raw value must never be stored. */
  hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }
}
