/**
 * Offline steps of the legacy single-tenant migration (Console `docs/legacy-tenant-migration.md`),
 * called by the deployment repository's migration orchestrator with writers stopped and the tenant
 * frozen. Run with tsx; this entry never loads env files.
 *
 *   REENCRYPT_DATABASE_URL=<TITU Work business database maintenance URL> \
 *   LEGACY_KEY_VAULTS_SECRET=<legacy KEY_VAULTS_SECRET> KEY_VAULTS_SECRET=<current> \
 *     tsx scripts/legacyTenantMigration/index.ts reencrypt-secrets --tenant-id <id> [--apply]
 *
 *   S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY [/ S3_REGION / S3_ENABLE_PATH_STYLE] \
 *     tsx scripts/legacyTenantMigration/index.ts copy-objects --tenant-id <id> \
 *       --mode dry-run|apply|verify|rollback [--exclude-prefix admin-images/ ...]
 *
 * Both print one JSON report. Exit code: 0 done, 2 the report needs operator action (rows or
 * objects that cannot be moved), 1 configuration or execution error (stable code only).
 */
import { parseArgs } from 'node:util';

import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Client } from 'pg';

import { tenantDbNames } from '../../packages/database/src/tenant/names';

const reencryptSecrets = async (tenantId: string, apply: boolean) => {
  const connectionString = process.env.REENCRYPT_DATABASE_URL;
  const legacySecret = process.env.LEGACY_KEY_VAULTS_SECRET;
  if (!connectionString || !legacySecret || !process.env.KEY_VAULTS_SECRET)
    throw new Error('REENCRYPT_CONFIGURATION_REQUIRED');
  const { reencryptLegacySecrets } =
    await import('../../apps/server/src/services/legacyTenantMigration/reencryptSecrets');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    const { schemaName } = tenantDbNames(tenantId);
    const { rows } = await client.query<{ found: string | null }>(
      'SELECT to_regnamespace($1)::text AS found',
      [schemaName],
    );
    if (!rows[0]?.found) throw new Error('TENANT_SCHEMA_MISSING');
    await client.query(`SET LOCAL search_path TO "${schemaName}"`);
    const report = await reencryptLegacySecrets({
      db: client,
      dryRun: !apply,
      legacySecret,
      tenantId,
    });
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { report, needsOperator: report.failures.length > 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
};

const s3Store = () => {
  const { S3_ACCESS_KEY_ID, S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_SECRET_ACCESS_KEY } = process.env;
  if (!S3_ACCESS_KEY_ID || !S3_BUCKET || !S3_ENDPOINT || !S3_SECRET_ACCESS_KEY)
    throw new Error('S3_CONFIGURATION_REQUIRED');
  const client = new S3Client({
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
    endpoint: S3_ENDPOINT,
    // Same reading as the application's `fileEnv`.
    forcePathStyle: process.env.S3_ENABLE_PATH_STYLE === '1',
    region: S3_REGION || 'us-east-1',
  });
  return {
    copy: async (from: string, to: string) => {
      await client.send(
        new CopyObjectCommand({
          Bucket: S3_BUCKET,
          CopySource: `${S3_BUCKET}/${from.split('/').map(encodeURIComponent).join('/')}`,
          Key: to,
        }),
      );
    },
    delete: async (keys: string[]) => {
      for (let i = 0; i < keys.length; i += 1000)
        await client.send(
          new DeleteObjectsCommand({
            Bucket: S3_BUCKET,
            Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
          }),
        );
    },
    list: async (prefix: string) => {
      const objects: Array<{ key: string; size: number }> = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: S3_BUCKET,
            ContinuationToken: token,
            Prefix: prefix || undefined,
          }),
        );
        for (const item of page.Contents ?? [])
          if (item.Key) objects.push({ key: item.Key, size: item.Size ?? 0 });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },
  };
};

const copyObjects = async (tenantId: string, mode: string, excludePrefixes: string[]) => {
  if (!['apply', 'dry-run', 'rollback', 'verify'].includes(mode))
    throw new Error('COPY_MODE_INVALID');
  const { copyLegacyObjects } =
    await import('../../apps/server/src/services/legacyTenantMigration/copyObjects');
  const report = await copyLegacyObjects({
    excludePrefixes,
    mode: mode as 'apply' | 'dry-run' | 'rollback' | 'verify',
    store: s3Store(),
    tenantId,
  });
  return {
    needsOperator:
      report.invalidKeys.length > 0 ||
      (mode === 'verify' && (report.missing.length > 0 || report.mismatched.length > 0)),
    report,
  };
};

const main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'apply': { type: 'boolean' },
      'exclude-prefix': { multiple: true, type: 'string' },
      'mode': { type: 'string' },
      'tenant-id': { type: 'string' },
    },
  });
  const tenantId = values['tenant-id'];
  if (!tenantId) throw new Error('TENANT_ID_REQUIRED');
  const [command] = positionals;
  const result =
    command === 'reencrypt-secrets'
      ? await reencryptSecrets(tenantId, values.apply === true)
      : command === 'copy-objects'
        ? await copyObjects(tenantId, values.mode ?? 'dry-run', values['exclude-prefix'] ?? [])
        : undefined;
  if (!result) throw new Error('USAGE: reencrypt-secrets | copy-objects');
  console.log(JSON.stringify(result.report, null, 2));
  if (result.needsOperator) process.exitCode = 2;
};

// Database, S3 and crypto errors can carry connection details or secrets: print a stable code.
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  console.error(/^[A-Z][\d:A-Z_ |-]+$/.test(message) ? message : 'LEGACY_TENANT_MIGRATION_FAILED');
  process.exitCode = 1;
});
