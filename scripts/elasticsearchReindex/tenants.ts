import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';
import type { ClientConfig } from 'pg';
import { z } from 'zod';

import type { TenantDatabaseTarget } from '../../apps/server/src/services/tenantControlPlane/tenantDatabases';
import { resolveElasticsearchTransport } from '../../packages/database/src/repositories/ftsSearch/elasticsearch/url';
import { tenantFtsSearchNamespace, tenantHash } from '../../packages/database/src/tenant/names';
import {
  assertFtsSearchReindexElasticsearchHostname,
  resolveFtsSearchReindexElasticsearchEnvironment,
} from './options';
import { summarizeFtsSearchReindexError } from './runtime/auditLogger';
import { listFtsSearchReindexCheckpoints } from './runtime/checkpointRepository';
import {
  FtsSearchMigrationLockClient,
  isFtsSearchBootstrapLockOwner,
} from './runtime/migrationLock';

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
 *
 * `--new-tenants-only` (with `--apply --fresh-run --yes`) onboards tenants that
 * were provisioned after the initial backfill: it picks the tenants with no
 * checkpoint in their state directory, installs the capture triggers as the
 * tenant owner (the reindex runs as the runtime role, which cannot create
 * them), then runs the fresh backfill. Existing tenants get read-only capture
 * checks (installation/upgrades only when needed); unfinished checkpoints resume
 * without `--fresh-run`. Ready tenants never start a reindex child. `--fresh-run` still refuses a target whose aliases
 * already exist. The same run removes what destroyed tenants left behind: a
 * tenant whose destruction completed (`tenant_destruction.completed_at`, the
 * Work terminal that outlives every other record) loses every index of its
 * namespace, including the alias-less `-fts-search-control` index, and its
 * state directory. Dropping the tenant schema does not touch either.
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
    child.on('close', (code, signal) => {
      // The development runner may have a child of its own. A signal is not proof it stopped;
      // leave recovery to the Pod-deadline-based stale check instead of releasing immediately.
      if (signal)
        reject(
          new Error(
            `Reindex child terminated by ${signal}; retaining any bootstrap lock until stale recovery`,
          ),
        );
      else resolve(code ?? 1);
    });
  });

const NEW_TENANTS_ONLY = '--new-tenants-only';

const bootstrapStaleLockSeconds = (value: string | undefined) => {
  const seconds = Number(value);
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(seconds * 1000))
    throw new Error(
      'ES_REINDEX_BOOTSTRAP_STALE_LOCK_SECONDS is required with --new-tenants-only and must be a positive integer',
    );
  // Deployment must set this beyond the bootstrap Job's activeDeadlineSeconds (4200 > 3600),
  // so Kubernetes has terminated the old Pod before an idle bootstrap lock can be recovered.
  return seconds;
};

const bootstrapLockClient = (namespace: string, argv: string[], environment: NodeJS.ProcessEnv) => {
  const { apiKeyEnvironmentName, expectedHostPrefix, urlEnvironmentName } =
    resolveFtsSearchReindexElasticsearchEnvironment(argv);
  const url = environment[urlEnvironmentName] ?? '';
  const client = new FtsSearchMigrationLockClient({
    namespace,
    url,
    apiKey: environment[apiKeyEnvironmentName],
    allowInsecureHttp: environment.ES_ALLOW_INSECURE_HTTP === 'true',
  });
  assertFtsSearchReindexElasticsearchHostname(new URL(url).hostname, expectedHostPrefix);
  return client;
};

/** Only bootstrap calls this; manual migration locks retain their existing recovery contract. */
const recoverBootstrapLock = async (
  client: FtsSearchMigrationLockClient,
  tenantId: string,
  staleSeconds: number,
  log: (...values: unknown[]) => void,
  exitedOwner?: string,
) => {
  let lock;
  try {
    lock = await client.read();
  } catch (cause) {
    throw new Error(
      `Cannot inspect migration lock for tenant ${tenantId}, exited owner ${exitedOwner ?? 'not observed'}; no recovery: ${summarizeFtsSearchReindexError(cause)}`,
      { cause },
    );
  }
  if (!lock) return;
  const details = `tenant ${tenantId}, owner ${lock.owner}, command ${lock.command}, acquiredAt ${lock.acquiredAt}`;
  const manual = `node /app/fts-search-elasticsearch-reindex-tenants.cjs --tenant=${tenantId} --release-lock=${lock.owner} --yes`;
  let reason: string;
  if (exitedOwner !== undefined) {
    if (lock.owner !== exitedOwner)
      throw new Error(
        `Retaining migration lock (${details}): exited child owner ${exitedOwner} does not match; manual recovery after confirming the owner stopped: ${manual}`,
      );
    reason = 'matching child has closed with a non-zero exit';
  } else {
    if (!isFtsSearchBootstrapLockOwner(lock.owner))
      throw new Error(
        `Retaining migration lock (${details}): not a bootstrap owner; manual recovery after confirming the owner stopped: ${manual}`,
      );
    if (Date.parse(lock.acquiredAt) >= Date.now() - staleSeconds * 1000)
      throw new Error(
        `Retaining migration lock (${details}): bootstrap owner has not exceeded ${staleSeconds}s; manual recovery after confirming the owner stopped: ${manual}`,
      );
    reason = `bootstrap owner is older than ${staleSeconds}s (beyond the Job/Pod termination deadline)`;
  }
  try {
    await client.assertNoNamespaceTasks();
    await client.release(lock.owner);
  } catch (cause) {
    throw new Error(
      `Migration lock recovery refused or failed (${details}); no takeover: ${summarizeFtsSearchReindexError(cause)}; manual recovery after confirming the owner stopped: ${manual}`,
      { cause },
    );
  }
  log(
    `♻ Recovered migration lock (${details}): ${reason}; namespace write/admin task check was empty`,
  );
};

export interface RunTenantReindexOptions {
  argv: string[];
  /** Deletes every index of one tenant namespace and returns their names (`--new-tenants-only`). */
  deleteIndices?: (namespace: string) => Promise<string[]>;
  environment: NodeJS.ProcessEnv;
  /** Checks capture, installing/upgrading it as owner only when necessary (`--new-tenants-only`). */
  installCapture?: (tenantId: string) => Promise<void>;
  /** Tenants whose destruction completed (`--new-tenants-only`). */
  listDestroyedTenants?: () => Promise<string[]>;
  listTargets: (tenantIds: string[]) => Promise<TenantDatabaseTarget[]>;
  log?: (...values: unknown[]) => void;
  parseTenants: (argv: string[]) => string[];
  run?: (args: string[], childEnv: NodeJS.ProcessEnv) => Promise<number>;
}

export const runTenantReindex = async ({
  argv,
  deleteIndices = (namespace) => deleteNamespaceIndices(namespace, argv, environment),
  environment,
  installCapture = installTenantCapture,
  listDestroyedTenants = listCompletedDestructions,
  listTargets,
  log = console.log,
  parseTenants,
  run = runChild,
}: RunTenantReindexOptions): Promise<number> => {
  const namespace = environment.ES_INDEX_NAMESPACE;
  if (!namespace) throw new Error('ES_INDEX_NAMESPACE is required');
  const newTenantsOnly = argv.includes(NEW_TENANTS_ONLY);
  if (
    newTenantsOnly &&
    !(
      environment.ES_REINDEX_STATE_DIR &&
      argv.includes('--apply') &&
      argv.includes('--fresh-run') &&
      argv.includes('--yes')
    )
  )
    throw new Error(
      `${NEW_TENANTS_ONLY} requires ES_REINDEX_STATE_DIR, --apply, --fresh-run and --yes`,
    );
  const staleSeconds = newTenantsOnly
    ? bootstrapStaleLockSeconds(environment.ES_REINDEX_BOOTSTRAP_STALE_LOCK_SECONDS)
    : undefined;
  const passthrough = argv.filter(
    (argument, index) =>
      !argument.startsWith('--tenant=') &&
      argument !== '--tenant' &&
      argument !== NEW_TENANTS_ONLY &&
      argv[index - 1] !== '--tenant',
  );

  const targets = await listTargets(parseTenants(argv));
  const failed: string[] = [];
  if (newTenantsOnly) {
    const live = new Set(targets.map((target) => target.tenantId));
    for (const tenantId of await listDestroyedTenants()) {
      if (live.has(tenantId)) continue;
      const stateDirectory = path.join(environment.ES_REINDEX_STATE_DIR!, tenantHash(tenantId));
      try {
        const indices = await deleteIndices(tenantFtsSearchNamespace(namespace, tenantId));
        const hadState = existsSync(stateDirectory);
        await rm(stateDirectory, { force: true, recursive: true });
        if (indices.length > 0 || hadState)
          log(
            '🧹 Removed full-text search data of destroyed tenant %s: %d index(es)%s',
            tenantId,
            indices.length,
            hadState ? ' and its state directory' : '',
          );
      } catch (error) {
        console.error(
          '❌ Cleanup failed for destroyed tenant %s:',
          tenantId,
          summarizeFtsSearchReindexError(error),
        );
        failed.push(tenantId);
      }
    }
  }
  let processed = 0;
  for (const target of targets) {
    const stateDirectory = environment.ES_REINDEX_STATE_DIR
      ? path.join(environment.ES_REINDEX_STATE_DIR, target.h24)
      : undefined;
    let childArgs = passthrough;
    let lockClient: FtsSearchMigrationLockClient | undefined;
    try {
      if (newTenantsOnly) {
        const checkpoints = await listFtsSearchReindexCheckpoints(stateDirectory!);
        const tenantNamespace = tenantFtsSearchNamespace(namespace, target.tenantId);
        if (checkpoints.some(({ checkpoint }) => checkpoint.run.namespace !== tenantNamespace))
          throw new Error(
            `FTS reindex checkpoint namespace does not match tenant ${target.tenantId}`,
          );
        if (checkpoints.length > 0) {
          const pending = checkpoints.filter(
            ({ checkpoint }) =>
              !['completed', 'ready_for_incremental_sync'].includes(checkpoint.run.status) ||
              checkpoint.progress.some(
                ({ status, failedCount }) => status !== 'completed' || failedCount > 0,
              ),
          );
          if (pending.length === 0) {
            await installCapture(target.tenantId);
            continue;
          }
          // Never turn a retry into a new run or change the explicit CLI fresh-run contract.
          childArgs = passthrough.filter((argument) => argument !== '--fresh-run');
        }
        // Also cover a crash between acquiring the first lock and persisting the first checkpoint.
        lockClient = bootstrapLockClient(tenantNamespace, argv, environment);
        await recoverBootstrapLock(lockClient, target.tenantId, staleSeconds!, log);
        await installCapture(target.tenantId);
      }
      if (stateDirectory) await mkdir(stateDirectory, { mode: 0o700, recursive: true });

      processed += 1;
      log('🔎 Elasticsearch reindex for tenant %s', target.tenantId);
      const owner = newTenantsOnly ? `bootstrap:${randomUUID()}` : undefined;
      const code = await run(childArgs, {
        ...environment,
        DATABASE_URL: await tenantDatabaseUrl(target.clientConfig, stateDirectory),
        ES_INDEX_NAMESPACE: tenantFtsSearchNamespace(namespace, target.tenantId),
        ...(stateDirectory && { ES_REINDEX_STATE_DIR: stateDirectory }),
        ...(owner && { ES_REINDEX_LOCK_OWNER: owner }),
      });
      if (code !== 0) {
        if (lockClient)
          await recoverBootstrapLock(lockClient, target.tenantId, staleSeconds!, log, owner);
        failed.push(target.tenantId);
      }
    } catch (error) {
      console.error(
        '❌ Elasticsearch onboarding failed for tenant %s:',
        target.tenantId,
        summarizeFtsSearchReindexError(error),
        ...(error instanceof Error && error.cause !== undefined
          ? [summarizeFtsSearchReindexError(error.cause)]
          : []),
      );
      failed.push(target.tenantId);
    }
  }

  if (failed.length > 0) {
    console.error('❌ Elasticsearch reindex failed for tenants: %s', failed.join(', '));
    return 1;
  }
  log('✅ Elasticsearch reindex finished for %d tenant(s)', processed);
  return 0;
};

const resolvedIndicesSchema = z.object({ indices: z.array(z.object({ name: z.string() })) });

/**
 * Deletes every index whose name starts with `<namespace>-` (aliases go with their index). The
 * namespace ends in the tenant hash, so the prefix cannot reach another tenant's indices; each name
 * is checked again before its exact-name DELETE.
 */
export const deleteNamespaceIndices = async (
  namespace: string,
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const names = resolveFtsSearchReindexElasticsearchEnvironment(argv);
  const { authorizationHeader, url } = resolveElasticsearchTransport({
    allowInsecureHttp: environment.ES_ALLOW_INSECURE_HTTP === 'true',
    apiKey: environment[names.apiKeyEnvironmentName],
    url: environment[names.urlEnvironmentName] ?? '',
  });
  const request = (pathname: string, init: RequestInit = {}) =>
    fetch(new URL(pathname, url), {
      ...init,
      headers: authorizationHeader ? { Authorization: authorizationHeader } : {},
      signal: AbortSignal.timeout(30_000),
    });
  const prefix = `${namespace}-`;
  const resolved = await request(
    `/_resolve/index/${encodeURIComponent(prefix)}*?expand_wildcards=all`,
  );
  if (!resolved.ok)
    throw new Error(`Elasticsearch index lookup failed for ${namespace} (${resolved.status})`);
  const indices = resolvedIndicesSchema
    .parse(await resolved.json())
    .indices.map(({ name }) => name)
    .filter((name) => name.startsWith(prefix));
  for (const index of indices) {
    const response = await request(`/${encodeURIComponent(index)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404)
      throw new Error(`Elasticsearch index deletion failed for ${index} (${response.status})`);
  }
  return indices;
};

const listCompletedDestructions = async () => {
  const [{ getPlatformDB, tenantDestruction }, { isNotNull }] = await Promise.all([
    import('../../packages/database/src/platform'),
    import('drizzle-orm'),
  ]);
  const rows = await getPlatformDB()
    .select({ tenantId: tenantDestruction.tenantId })
    .from(tenantDestruction)
    .where(isNotNull(tenantDestruction.completedAt));
  return rows.map(({ tenantId }) => tenantId);
};

const installTenantCapture = async (tenantId: string) => {
  const { installFtsSearchSyncCapture, listOwnerTenants } =
    await import('../installFtsSearchSyncCapture');
  await installFtsSearchSyncCapture({ listTenants: () => listOwnerTenants([tenantId]) });
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
