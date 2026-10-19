import { existsSync } from 'node:fs';
import path from 'node:path';

import * as dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as nodeMigrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

import * as platformSchema from '../../packages/database/src/platform/schemas';
// @ts-ignore tsgo handle esm import cjs and compatibility issues
import { DB_FAIL_INIT_HINT, DUPLICATE_EMAIL_HINT, PGVECTOR_HINT } from './errorHint';
// @ts-ignore tsgo handle esm import cjs and compatibility issues
import { assertPgSearchReady, PgSearchNotReadyError } from './pgSearchGuard';
import { runWithLockRetry } from './retry';
import { migrateUnlessReady, runStartupMigrations } from './startup';

// Load environment variables in priority order:
// 1. .env (lowest priority)
// 2. .env.[env] (medium priority, overrides .env)
// 3. .env.[env].local (highest priority, overrides previous)
// Use dotenv-expand to support ${var} variable expansion
const env = process.env.NODE_ENV || 'development';
dotenvExpand.expand(dotenv.config()); // Load .env
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}` })); // Load .env.[env] and override
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}.local` })); // Load .env.[env].local and override

/**
 * The platform chain in the repository (`tsx`) or next to the bundled script
 * in the Docker image (`/app/docker.cjs` + `/app/migrations`, see Dockerfile).
 */
const platformMigrationsFolder = () => {
  const candidates = [
    path.join(__dirname, '../../packages/database/migrations/platform'),
    path.join(__dirname, 'migrations/platform'),
  ];
  const found = candidates.find((folder) => existsSync(path.join(folder, 'meta/_journal.json')));
  if (!found) throw new Error('Platform migrations folder not found');
  // The tenant chain is located from the working directory, as in the Next
  // server (which runs from /app); the image starts this script from `/`.
  if (found === candidates[1]) process.chdir(__dirname);
  return found;
};

/** `--tenant <id>` (repeatable) limits the tenant upgrade to those tenants. */
const tenantArgs = () => {
  const ids: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tenant' && argv[i + 1]) ids.push(argv[++i]);
    else if (argv[i].startsWith('--tenant=')) ids.push(argv[i].slice('--tenant='.length));
  }
  return ids;
};

/**
 * Boot callers (the image launchers) pass `--tolerate-tenant-failures`: a tenant whose chain
 * failed answers 503 until a rerun succeeds, and must not keep the other tenants' replicas from
 * starting. Without it this is the standalone migration CLI (release Jobs, `db:migrate`), which
 * exits non-zero when any tenant was left unavailable so the orchestrator cannot go on.
 */
const toleratesTenantFailures = () => process.argv.slice(2).includes('--tolerate-tenant-failures');

/**
 * 1. The platform chain on `DATABASE_URL` (`public`: tenant routing metadata only).
 * 2. Every tenant chain on each active tenant, as that tenant's schema owner
 *    (spec FR-MD-02): the OSS chain, then the chains distributions register
 *    (`registerBusinessTenantMigrators`, the `@lobechat/business-tenant` slot).
 *    Tenants Console provisions later are migrated by the provision flow itself.
 *
 * `db:migrate` runs this file with tsx; the Docker image runs the same file
 * bundled by esbuild as `/app/docker.cjs` on every start.
 */
const runMigrations = async () => {
  const { upgradeTenantSchemas } =
    await import('../../apps/server/src/services/tenantControlPlane/upgrade');
  const { PostgresTenantDatabaseExecutor } =
    await import('../../apps/server/src/services/tenantControlPlane/postgresExecutor');

  /**
   * The pg_search guard checks the tables `search_path` resolves to, and the BM25 indexes live
   * in each tenant schema (the platform `public` schema has none), so it runs per tenant, after
   * that tenant's chains and runtime checks pass.
   */
  class GuardedTenantExecutor extends PostgresTenantDatabaseExecutor {
    async migrate(ctx: Parameters<PostgresTenantDatabaseExecutor['migrate']>[0]) {
      // After waiting for the startup lock, followers verify the journals and
      // runtime permissions without rerunning any completed migration chain.
      await migrateUnlessReady(
        () => this.verify({ bundle: ctx.bundle, tenantId: ctx.tenantId }),
        () => super.migrate(ctx),
      );
    }

    async verifyDiscovery(args: Parameters<PostgresTenantDatabaseExecutor['verifyDiscovery']>[0]) {
      await super.verifyDiscovery(args);
      await this.withTenantCatalog(args.bundle, (query) => assertPgSearchReady(query));
    }
  }

  const time = Date.now();
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
  });
  // Losing this session also loses the advisory lock. Stop immediately, even
  // while tenant SQL is executing on its own connections.
  client.on('error', (error: NodeJS.ErrnoException) => {
    console.error('❌ Platform migration connection lost:', error.code ?? 'CONNECTION_LOST');
    process.exit(1);
  });
  let unavailable: string[];
  try {
    await client.connect();
    // A follower may wait longer than the request statement timeout while the
    // leader upgrades tenants. This session is reserved for startup only.
    await client.query('SET statement_timeout = 0');
    // The same pinned session owns the advisory lock and platform queries.
    const platformDB = drizzle(client, { schema: platformSchema });
    const tenantIds = tenantArgs();
    const result = await runStartupMigrations({
      client,
      migratePlatform: async () => {
        await runWithLockRetry(() =>
          nodeMigrate(platformDB, { migrationsFolder: platformMigrationsFolder() }),
        );
        console.log('✅ platform database migration pass. use: %s ms', Date.now() - time);
      },
      report: (event) => console.log(JSON.stringify(event)),
      upgradeTenants: () =>
        upgradeTenantSchemas(platformDB, {
          executor: new GuardedTenantExecutor(),
          tenantIds: tenantIds.length > 0 ? tenantIds : undefined,
        }),
    });
    unavailable = result.failed.map(({ tenantId }) => tenantId);
  } finally {
    await client.end();
  }

  const strictFailure = unavailable.length > 0 && !toleratesTenantFailures();
  if (strictFailure) {
    console.error(
      `❌ ${unavailable.length} tenant(s) left unavailable after migration (fix the cause and rerun): ${unavailable.join(', ')}`,
    );
  }
  process.exit(strictFailure ? 1 : 0);
};

const connectionString = process.env.DATABASE_URL;

// only migrate database if the connection string is available
if (connectionString) {
  runMigrations().catch((err) => {
    if (err instanceof PgSearchNotReadyError) {
      console.error(err.message);
      process.exit(1);
    }

    console.error('❌ Database migrate failed:', err);

    const errMsg = err.message as string;

    const constraint = (err as { constraint?: string })?.constraint;

    if (errMsg.includes('extension "vector" is not available')) {
      console.info(PGVECTOR_HINT);
    } else if (constraint === 'users_email_unique' || errMsg.includes('users_email_unique')) {
      console.info(DUPLICATE_EMAIL_HINT);
    } else if (errMsg.includes(`Cannot read properties of undefined (reading 'migrate')`)) {
      console.info(DB_FAIL_INIT_HINT);
    }

    process.exit(1);
  });
} else {
  console.log('🟢 not find database env or in desktop mode, migration skipped');
}
