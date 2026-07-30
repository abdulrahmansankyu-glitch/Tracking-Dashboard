import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Document storage with two interchangeable drivers.
 *
 * `local` writes to disk and is what runs in development and in a single-shop
 * self-hosted deployment. `s3` targets AWS S3 (or MinIO, which speaks the same API) and
 * is what runs in the cloud. Callers only ever see storage keys and signed URLs, so
 * switching drivers is an environment variable, not a code change.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver: 'local' | 's3';
  private readonly localPath: string;
  private readonly bucket: string;
  private readonly s3?: S3Client;

  constructor(private readonly configService: ConfigService) {
    this.driver = this.configService.get<'local' | 's3'>('storage.driver') ?? 'local';
    this.localPath = resolve(this.configService.get<string>('storage.localPath') ?? './storage');
    this.bucket = this.configService.get<string>('storage.bucket') ?? 'intoto-erp-documents';

    if (this.driver === 's3') {
      const endpoint = this.configService.get<string>('storage.endpoint');
      const accessKeyId = this.configService.get<string>('storage.accessKeyId');
      const secretAccessKey = this.configService.get<string>('storage.secretAccessKey');
      this.s3 = new S3Client({
        region: this.configService.get<string>('storage.region') ?? 'ap-south-1',
        ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
        ...(accessKeyId && secretAccessKey
          ? { credentials: { accessKeyId, secretAccessKey } }
          : {}),
      });
    }
    this.logger.log(`Storage driver: ${this.driver}`);
  }

  /**
   * Build a collision-proof, tenant-scoped key.
   * Grouping by organization then entity keeps a bucket listing navigable and makes an
   * S3 lifecycle rule ("archive supplier documents after 7 years") expressible by prefix.
   */
  buildKey(params: {
    organizationId: string;
    entityType: string;
    entityId: string;
    fileName: string;
  }): string {
    const safeName = params.fileName.replace(/[^\w.\-]/g, '_').slice(-120);
    return [
      params.organizationId,
      params.entityType.toLowerCase(),
      params.entityId,
      `${randomUUID()}-${safeName}`,
    ].join('/');
  }

  async put(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<{ key: string; checksum: string; size: number }> {
    const checksum = createHash('sha256').update(body).digest('hex');

    if (this.driver === 's3' && this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          // Encrypted at rest by the bucket; the checksum lets us detect corruption.
          ServerSideEncryption: 'AES256',
          Metadata: { checksum },
        }),
      );
    } else {
      const path = join(this.localPath, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    }

    return { key, checksum, size: body.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    if (this.driver === 's3' && this.s3) {
      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await response.Body?.transformToByteArray();
      if (!bytes) throw new Error(`Object ${key} is empty`);
      return Buffer.from(bytes);
    }
    return readFile(join(this.localPath, key));
  }

  async delete(key: string): Promise<void> {
    if (this.driver === 's3' && this.s3) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return;
    }
    await unlink(join(this.localPath, key)).catch(() => {
      // Already gone is the desired end state.
    });
  }

  /**
   * Time-limited download URL. Documents are never public: a supplier agreement or a
   * GST certificate must not be readable by anyone who guesses a URL.
   */
  async signedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    if (this.driver === 's3' && this.s3) {
      return getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    }
    // The local driver streams through an authenticated API route instead.
    return `/api/v1/documents/download/${encodeURIComponent(key)}`;
  }
}
