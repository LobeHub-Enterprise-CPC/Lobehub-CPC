import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';
import type { ClientConfig } from 'pg';

import type { TenantDatabaseTarget } from '../../apps/server/src/services/tenantControlPlane/tenantDatabases';
import { tenantFtsSearchNamespace } from '../../packages/database/src/tenant/names';
import { summarizeFtsSearchReindexError } from './runtime/auditLogger';

const env = process.env.NODE_ENV || 'development';
dotenvExpand.expand(dotenv.config());
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}` }));
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}.local` }));

/**
 * Elasticsearch reindex per tenant. Every tenant has its own business data
 * (its schema) and its own index namespace (`tenantFtsSearchNamespace`, the
 * one the application searches), so the reindex runs once per tenant: every
 * active tenant from the platform directory (`DATABASE_URL`), or the
 * `--tenant <id>` ones. Each run is the unchanged reindex command with the
 * tenant's database (runtime role, tenant schema first on the search path),
 * namespace and checkpoint directory (`$ES_REINDEX_STATE_DIR/<h24>`). The
 * remaining arguments pass through. Tenants run one at a time; a failing
 * tenant does not stop the others, and the command fails afterwards.
 */

const sslQuery = async (ssl: ClientConfig['ssl'], stateDirectory: string | undefined) => {
  if (!ssl) return { sslmode: 'disable' };
  if (typeof ssl !== 'object') return { sslmode: 'verify-full' };
  const query: Record<string, string> = {
    sslmode: ssl.rejectUnauthorized === false ? 'no-verify' : 'verify-full',
  };
  if (typeof ssl.ca === 'string' && ssl.ca) {
    if (!stateDirectory) throw new Error('ES_REINDEX_STATE_DIR is required for a tenant TLS CA');
    const caPath = path.join(stateDirectory, 'database-ca.pem');
    await writeFile(caPath, ssl.ca, { mode: 0o600 });
    await chmod(caPath, 0o600);
    query.sslrootcert = caPath;
  }
  return query;
};

/** `postgres://` URL for the child's `DATABASE_URL`; the CA, if any, goes to a 0600 file. */
export const tenantDatabaseUrl = async (
  config: ClientConfig,
  stateDirectory: string | undefined,
) => {
  const url = new URL('postgres://localhost');
  url.username = config.user ?? '';
  url.password = typeof config.password === 'string' ? config.password : '';
  url.hostname = config.host ?? 'localhost';
  url.port = String(config.port ?? 5432);
  url.pathname = `/${config.database ?? ''}`;
  for (const [key, value] of Object.entries({
    ...(await sslQuery(config.ssl, stateDirectory)),
    ...(config.options && { options: config.options }),
  }))
    url.searchParams.set(key, value);
  return url.toString();
};

/** The reindex entry: the bundled one next to this file in the image, else the repository runner. */
const reindexCommand = () => {
  const directory = path.dirname(path.resolve(process.argv[1] ?? '.'));
  const bundled = path.join(directory, 'fts-search-elasticsearch-reindex.cjs');
  if (existsSync(bundled)) return [bundled];
  return [path.join(directory, 'runner.mjs')];
};

const runChild = (args: string[], childEnv: NodeJS.ProcessEnv) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [...reindexCommand(), ...args], {
      env: childEnv,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

export interface RunTenantReindexOptions {
  argv: string[];
  environment: NodeJS.ProcessEnv;
  listTargets: (tenantIds: string[]) => Promise<TenantDatabaseTarget[]>;
  log?: (...values: unknown[]) => void;
  parseTenants: (argv: string[]) => string[];
  run?: (args: string[], childEnv: NodeJS.ProcessEnv) => Promise<number>;
}

export const runTenantReindex = async ({
  argv,
  environment,
  listTargets,
  log = console.log,
  parseTenants,
  run = runChild,
}: RunTenantReindexOptions): Promise<number> => {
  const namespace = environment.ES_INDEX_NAMESPACE;
  if (!namespace) throw new Error('ES_INDEX_NAMESPACE is required');
  const passthrough = argv.filter(
    (argument, index) =>
      !argument.startsWith('--tenant=') &&
      argument !== '--tenant' &&
      argv[index - 1] !== '--tenant',
  );

  const targets = await listTargets(parseTenants(argv));
  const failed: string[] = [];
  for (const target of targets) {
    const stateDirectory = environment.ES_REINDEX_STATE_DIR
      ? path.join(environment.ES_REINDEX_STATE_DIR, target.h24)
      : undefined;
    if (stateDirectory) await mkdir(stateDirectory, { mode: 0o700, recursive: true });

    log('🔎 Elasticsearch reindex for tenant %s', target.tenantId);
    const code = await run(passthrough, {
      ...environment,
      DATABASE_URL: await tenantDatabaseUrl(target.clientConfig, stateDirectory),
      ES_INDEX_NAMESPACE: tenantFtsSearchNamespace(namespace, target.tenantId),
      ...(stateDirectory && { ES_REINDEX_STATE_DIR: stateDirectory }),
    });
    if (code !== 0) failed.push(target.tenantId);
  }

  if (failed.length > 0) {
    console.error('❌ Elasticsearch reindex failed for tenants: %s', failed.join(', '));
    return 1;
  }
  log('✅ Elasticsearch reindex finished for %d tenant(s)', targets.length);
  return 0;
};

const listTargets = async (tenantIds: string[]) => {
  const [{ getPlatformDB }, { listTenantDatabases }] = await Promise.all([
    import('../../packages/database/src/platform'),
    import('../../apps/server/src/services/tenantControlPlane/tenantDatabases'),
  ]);
  const { missing, targets } = await listTenantDatabases(getPlatformDB(), {
    role: 'runtime',
    tenantIds,
  });
  if (missing.length > 0) throw new Error(`Unknown tenants: ${missing.join(', ')}`);
  return targets;
};

const isDirectExecution = () => {
  const entrypoint = path.basename(process.argv[1] ?? '');
  return entrypoint.startsWith('tenants.') || entrypoint.includes('reindex-tenants');
};

if (isDirectExecution()) {
  void (async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    const { parseTenantArguments } =
      await import('../../apps/server/src/services/tenantControlPlane/tenantDatabases');
    return runTenantReindex({
      argv: process.argv.slice(2),
      environment: process.env,
      listTargets,
      parseTenants: parseTenantArguments,
    });
  })().then(
    (exitCode) => process.exit(exitCode),
    (error) => {
      console.error(
        '❌ Elasticsearch tenant reindex failed:',
        summarizeFtsSearchReindexError(error),
      );
      process.exit(1);
    },
  );
}
