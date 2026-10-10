import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';

import { summarizeFtsSearchReindexError } from '../elasticsearchReindex/runtime/auditLogger';
import { runWithLockRetry as defaultRunWithLockRetry } from '../migrateServerDB/retry';

// Load environment variables in priority order:
// 1. .env (lowest priority)
// 2. .env.[env] (medium priority, overrides .env)
// 3. .env.[env].local (highest priority, overrides previous)
// Use dotenv-expand to support ${var} variable expansion
const env = process.env.NODE_ENV || 'development';
dotenvExpand.expand(dotenv.config()); // Load .env
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}` })); // Load .env.[env] and override
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}.local` })); // Load .env.[env].local and override

export type FtsSearchSyncCaptureRepository = {
  installCaptureInfrastructure: () => Promise<void>;
};

/** One tenant schema the capture is installed in, as its schema owner. */
export interface FtsSearchSyncCaptureTenant {
  open: () => Promise<{ close: () => Promise<void>; repository: FtsSearchSyncCaptureRepository }>;
  tenantId: string;
}

type ListTenants = () => Promise<FtsSearchSyncCaptureTenant[]>;
type RunWithLockRetry = (operation: () => Promise<void>) => Promise<void>;
type Logger = (...arguments_: unknown[]) => void;

interface FtsSearchSyncCaptureEnvironment {
  DATABASE_URL?: string;
}

export type InstallFtsSearchSyncCaptureOptions = {
  env?: FtsSearchSyncCaptureEnvironment;
  listTenants?: ListTenants;
  runWithLockRetry?: RunWithLockRetry;
};

export type FtsSearchSyncCaptureCliOptions = InstallFtsSearchSyncCaptureOptions & {
  logError?: Logger;
  logSuccess?: Logger;
};

/**
 * Every active tenant (or the `--tenant` ones) from the platform directory
 * (`DATABASE_URL`). Capture functions and triggers live in each tenant schema
 * and are created by its owner; the connection pins the tenant schema first on
 * the search path.
 */
const listTenants: ListTenants = async () => {
  // Keep database initialization out of the module graph until the required environment is set.
  const [
    { getPlatformDB },
    { listTenantDatabases, parseTenantArguments },
    { drizzle },
    pg,
    outbox,
  ] = await Promise.all([
    import('../../packages/database/src/platform'),
    import('../../apps/server/src/services/tenantControlPlane/tenantDatabases'),
    import('drizzle-orm/node-postgres'),
    import('pg'),
    import('../../packages/database/src/repositories/ftsSearchSyncOutbox'),
  ]);
  const { missing, targets } = await listTenantDatabases(getPlatformDB(), {
    role: 'owner',
    tenantIds: parseTenantArguments(process.argv.slice(2)),
  });
  if (missing.length > 0) throw new Error(`Unknown tenants: ${missing.join(', ')}`);

  return targets.map((target) => ({
    open: async () => {
      const pool = new pg.default.Pool({ ...target.clientConfig, max: 1 });
      return {
        close: () => pool.end(),
        repository: new outbox.FtsSearchSyncOutboxRepository(drizzle(pool)),
      };
    },
    tenantId: target.tenantId,
  }));
};

/**
 * Installs capture in every tenant schema, one tenant at a time. A failing
 * tenant does not stop the others; the run fails afterwards, naming them.
 */
export const installFtsSearchSyncCapture = async ({
  env: environment = { DATABASE_URL: process.env.DATABASE_URL },
  listTenants: list = listTenants,
  runWithLockRetry = defaultRunWithLockRetry,
}: InstallFtsSearchSyncCaptureOptions = {}): Promise<string[]> => {
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const tenants = await list();
  const failed: { error: unknown; tenantId: string }[] = [];
  for (const tenant of tenants) {
    try {
      const { close, repository } = await tenant.open();
      try {
        await runWithLockRetry(() => repository.installCaptureInfrastructure());
      } finally {
        await close();
      }
    } catch (error) {
      failed.push({ error, tenantId: tenant.tenantId });
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `capture installation failed for tenants ${failed.map(({ tenantId }) => tenantId).join(', ')}`,
      { cause: failed[0].error },
    );
  }
  return tenants.map(({ tenantId }) => tenantId);
};

export const runFtsSearchSyncCaptureCli = async ({
  logError = console.error,
  logSuccess = console.log,
  ...options
}: FtsSearchSyncCaptureCliOptions = {}) => {
  try {
    const tenantIds = await installFtsSearchSyncCapture(options);
    logSuccess(
      '✅ full-text search sync capture infrastructure installed in %d tenant(s)',
      tenantIds.length,
    );
    return 0;
  } catch (error) {
    logError(
      '❌ Full-text search sync capture installation failed:',
      summarizeFtsSearchReindexError(error),
    );
    if (error instanceof Error && error.cause !== undefined)
      logError('First failure:', summarizeFtsSearchReindexError(error.cause));
    return 1;
  }
};

const isDirectExecution = () => {
  const entrypoint = process.argv[1];

  return entrypoint !== undefined && path.resolve(entrypoint) === fileURLToPath(import.meta.url);
};

if (isDirectExecution()) {
  void runFtsSearchSyncCaptureCli().then((exitCode) => {
    process.exit(exitCode);
  });
}
