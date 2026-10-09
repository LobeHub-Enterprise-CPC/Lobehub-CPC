import { existsSync } from 'node:fs';
import path from 'node:path';

import * as dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';
import { migrate as nodeMigrate } from 'drizzle-orm/node-postgres/migrator';

// @ts-ignore tsgo handle esm import cjs and compatibility issues
import { DB_FAIL_INIT_HINT, DUPLICATE_EMAIL_HINT, PGVECTOR_HINT } from './errorHint';
import { runWithLockRetry } from './retry';

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
  const { getPlatformDB } = await import('../../packages/database/src/platform');
  const { upgradeTenantSchemas } =
    await import('../../apps/server/src/services/tenantControlPlane/upgrade');

  const time = Date.now();
  const platformDB = getPlatformDB();
  await runWithLockRetry(() =>
    nodeMigrate(platformDB, { migrationsFolder: platformMigrationsFolder() }),
  );
  console.log('✅ platform database migration pass. use: %s ms', Date.now() - time);

  const tenantIds = tenantArgs();
  const { failed, migrated } = await upgradeTenantSchemas(platformDB, {
    tenantIds: tenantIds.length > 0 ? tenantIds : undefined,
  });
  console.log('✅ tenant schemas migrated: %d', migrated.length);
  if (failed.length > 0) {
    for (const { reason, tenantId } of failed)
      console.error('❌ tenant %s migration failed: %s', tenantId, reason);
    process.exit(1);
  }

  process.exit(0);
};

const connectionString = process.env.DATABASE_URL;

// only migrate database if the connection string is available
if (connectionString) {
  runMigrations().catch((err) => {
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
