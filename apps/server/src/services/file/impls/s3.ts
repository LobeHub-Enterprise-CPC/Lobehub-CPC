import { parseTenantPath } from '@lobechat/business-tenant/routing';
import { type LobeChatDatabase } from '@lobechat/database';
import { requireTenantScope } from '@lobechat/database/tenant';
import debug from 'debug';
import urlJoin from 'url-join';

import { FileModel } from '@/database/models/file';
import { fileEnv } from '@/envs/file';
import { getRedisConfig } from '@/envs/redis';
import { initializeRedis, isRedisEnabled } from '@/libs/redis';
import { FileS3 } from '@/server/modules/S3';
import { logicalObjectKey, tenantObjectKey } from '@/server/modules/S3/tenantKey';

import type { FileServiceImpl, PreSignedUpload } from './type';

const log = debug('lobe-file:s3');

const PRESIGNED_PREVIEW_CACHE_SAFETY_SECONDS = 60;
const PRESIGNED_PREVIEW_CACHE_MAX_SECONDS = 3600;
const PRESIGNED_PREVIEW_CACHE_KEY_PREFIX = 'file:presigned-preview:';

interface PresignedPreviewCacheEntry {
  expiresAt: number;
  url: string;
}

const presignedPreviewUrlCache = new Map<string, PresignedPreviewCacheEntry>();

const createPresignedPreviewCacheKey = (key: string, expiresIn: number) =>
  `${PRESIGNED_PREVIEW_CACHE_KEY_PREFIX}${expiresIn}:${key}`;

const getPresignedPreviewCacheTtlSeconds = (expiresInSeconds: number) =>
  Math.min(
    Math.max(expiresInSeconds - PRESIGNED_PREVIEW_CACHE_SAFETY_SECONDS, 0),
    PRESIGNED_PREVIEW_CACHE_MAX_SECONDS,
  );

/**
 * S3-based file service implementation
 */
export class S3StaticFileImpl implements FileServiceImpl {
  private readonly s3: FileS3;
  private readonly db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
    this.s3 = new FileS3();
  }

  async deleteFile(key: string) {
    return this.s3.deleteFile(key);
  }

  async deleteFiles(keys: string[]) {
    return this.s3.deleteFiles(keys);
  }

  async getFileContent(key: string, byteLength?: number): Promise<string> {
    return byteLength === undefined
      ? this.s3.getFileContent(key)
      : this.s3.getFileContent(key, byteLength);
  }

  async getFileByteArray(key: string): Promise<Uint8Array> {
    return this.s3.getFileByteArray(key);
  }

  async createPreSignedUrl(key: string): Promise<string> {
    return this.s3.createPreSignedUrl(key);
  }

  async createPreSignedUpload(key: string): Promise<PreSignedUpload> {
    return this.s3.createPreSignedUpload(key);
  }

  async getFileMetadata(key: string): Promise<{ contentLength: number; contentType?: string }> {
    return this.s3.getFileMetadata(key);
  }

  async createPreSignedUrlForPreview(key: string, expiresIn?: number): Promise<string> {
    return this.s3.createPreSignedUrlForPreview(key, expiresIn);
  }

  async createPreSignedUrlForDownload(
    key: string,
    fileName: string,
    expiresIn?: number,
  ): Promise<string> {
    return this.s3.createPreSignedUrlForDownload(key, fileName, expiresIn);
  }

  private async getStorageKeyFromUrl(url: string): Promise<string> {
    if (!url.startsWith('http://') && !url.startsWith('https://')) return url;

    const extractedKey = await this.getKeyFromFullUrl(url);
    if (!extractedKey) {
      throw new Error('Key not found from url: ' + url);
    }

    return extractedKey;
  }

  async createDownloadUrl(url: string, fileName: string, expiresIn?: number): Promise<string> {
    const key = await this.getStorageKeyFromUrl(url);

    return this.createPreSignedUrlForDownload(key, fileName, expiresIn);
  }

  private async getCachedPreSignedUrlForPreview(key: string, expiresIn?: number): Promise<string> {
    const expiresInSeconds = expiresIn ?? fileEnv.S3_PREVIEW_URL_EXPIRE_IN;
    // The physical key carries the tenant, so tenants never share a cache entry.
    const cacheKey = createPresignedPreviewCacheKey(tenantObjectKey(key), expiresInSeconds);
    const ttlSeconds = getPresignedPreviewCacheTtlSeconds(expiresInSeconds);
    const now = Date.now();
    const cached = presignedPreviewUrlCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return cached.url;
    }

    try {
      const redisConfig = getRedisConfig();
      const redis = isRedisEnabled(redisConfig) ? await initializeRedis(redisConfig) : null;
      const cachedUrl = await redis?.get(cacheKey);

      if (cachedUrl) {
        if (ttlSeconds > 0) {
          presignedPreviewUrlCache.set(cacheKey, {
            expiresAt: now + ttlSeconds * 1000,
            url: cachedUrl,
          });
        }

        return cachedUrl;
      }
    } catch (error) {
      log('Failed to read presigned preview URL cache from Redis: %O', error);
    }

    const url = await this.createPreSignedUrlForPreview(key, expiresIn);

    if (ttlSeconds > 0) {
      presignedPreviewUrlCache.set(cacheKey, {
        expiresAt: now + ttlSeconds * 1000,
        url,
      });

      try {
        const redisConfig = getRedisConfig();
        const redis = isRedisEnabled(redisConfig) ? await initializeRedis(redisConfig) : null;
        await redis?.set(cacheKey, url, { ex: ttlSeconds });
      } catch (error) {
        log('Failed to write presigned preview URL cache to Redis: %O', error);
      }
    }

    return url;
  }

  async createCachedPreSignedUrlForPreview(
    url?: string | null,
    expiresIn?: number,
  ): Promise<string> {
    if (!url) return '';

    const key = await this.getStorageKeyFromUrl(url);

    return await this.getCachedPreSignedUrlForPreview(key, expiresIn);
  }

  async uploadContent(path: string, content: string) {
    return this.s3.uploadContent(path, content);
  }

  async getFullFileUrl(url?: string | null, expiresIn?: number): Promise<string> {
    if (!url) return '';

    const key = await this.getStorageKeyFromUrl(url);

    // If bucket is not set public read, or S3_PUBLIC_DOMAIN is not configured,
    // reuse the same presigned preview URL briefly so repeated chat turns keep
    // stable media URLs and can reuse provider-side prefix caches.
    const publicUrlBase = fileEnv.S3_SET_ACL ? fileEnv.S3_PUBLIC_DOMAIN : undefined;
    if (!publicUrlBase) {
      return await this.getCachedPreSignedUrlForPreview(key, expiresIn);
    }

    const objectKey = tenantObjectKey(key);

    if (fileEnv.S3_ENABLE_PATH_STYLE) {
      return urlJoin(publicUrlBase, fileEnv.S3_BUCKET!, objectKey);
    }

    return urlJoin(publicUrlBase, objectKey);
  }

  /**
   * The logical key behind a file URL of the current tenant, or `null`.
   *
   * - File proxy URL `/t/{slug}/f/{fileId}`: looked up in the tenant database;
   *   another tenant's slug is not resolved.
   * - Public object URL `…/[bucket/]t/{tenantId}/{key}`: the tenant root is
   *   stripped; an object outside the current tenant's root is not resolved.
   */
  async getKeyFromFullUrl(url: string): Promise<string | null> {
    try {
      const { pathname } = new URL(url);

      const { rest, tenantSlug } = parseTenantPath(pathname);
      if (rest.startsWith('/f/')) {
        if (tenantSlug !== requireTenantScope().slug) return null;
        const fileId = rest.slice(3);
        const file = await FileModel.getFileById(this.db, fileId);
        return file?.url ?? null;
      }

      let objectKey = pathname.replace(/^\/+/, '');
      if (fileEnv.S3_ENABLE_PATH_STYLE && fileEnv.S3_BUCKET) {
        const bucketPrefix = `${fileEnv.S3_BUCKET}/`;
        if (objectKey.startsWith(bucketPrefix)) objectKey = objectKey.slice(bucketPrefix.length);
      }

      return logicalObjectKey(objectKey);
    } catch {
      // If url is not a valid URL, return null
      return null;
    }
  }

  async uploadMedia(key: string, buffer: Buffer): Promise<{ key: string }> {
    await this.s3.uploadMedia(key, buffer);
    return { key };
  }

  async uploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<{ key: string }> {
    await this.s3.uploadBuffer(key, buffer, contentType);
    return { key };
  }
}
