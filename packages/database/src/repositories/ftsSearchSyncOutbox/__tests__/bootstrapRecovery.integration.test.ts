// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/pglite';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';

import { ReindexElasticsearch } from '../../../../../../scripts/elasticsearchReindex/__tests__/fixtures/reindexElasticsearch.fixture';
import { listFtsSearchReindexCheckpoints } from '../../../../../../scripts/elasticsearchReindex/runtime/checkpointRepository';
import { FtsSearchMigrationLockClient } from '../../../../../../scripts/elasticsearchReindex/runtime/migrationLock';
import { runTenantReindex } from '../../../../../../scripts/elasticsearchReindex/tenants';
import { materializeTenantMigrations } from '../../../tenant/migrator';
import { tenantDbNames, tenantFtsSearchNamespace } from '../../../tenant/names';
import { FtsSearchSyncOutboxRepository } from '../index';

it('runs the real index CLI child through a failed backfill, exact-owner recovery and checkpoint resume', async () => {
  const root = path.resolve(import.meta.dirname, '../../../../../..');
  const temporary = await mkdtemp(path.join(tmpdir(), 'bootstrap-cli-'));
  const directory = path.join(temporary, 'pg');
  const tenantId = '7a0c3d2e-1111-4222-8333-944455556666';
  const { schemaName, h24, runtimeUsername } = tenantDbNames(tenantId);
  const namespace = tenantFtsSearchNamespace('test', tenantId);
  const elasticsearch = new ReindexElasticsearch();
  const lock = new FtsSearchMigrationLockClient({
    namespace,
    url: 'http://localhost:9200',
    allowInsecureHttp: true,
  });
  const pglite = await PGlite.create({ dataDir: directory, extensions: { vector } });
  const children = new Set<ReturnType<typeof spawn>>();
  vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
  try {
    await pglite.exec(
      `CREATE EXTENSION IF NOT EXISTS vector; CREATE SCHEMA "${schemaName}"; SET search_path TO "${schemaName}", public`,
    );
    for (const folder of [
      path.join(root, 'packages/database/migrations'),
      path.join(root, 'packages/database/migrations/tenant'),
    ])
      for (const migration of materializeTenantMigrations(
        readMigrationFiles({ migrationsFolder: folder }),
        schemaName,
      ))
        for (const statement of migration.sql)
          if (!/pg_search|bm25/i.test(statement)) await pglite.exec(statement);
    const outbox = new FtsSearchSyncOutboxRepository(
      drizzle({ client: pglite }) as unknown as ConstructorParameters<
        typeof FtsSearchSyncOutboxRepository
      >[0],
    );
    await outbox.installCaptureInfrastructure();
    await pglite.exec(
      "INSERT INTO users (id) VALUES ('user'); INSERT INTO agents (id, user_id, title) VALUES ('agent-1', 'user', 'First'), ('agent-2', 'user', 'Second')",
    );
    await pglite.close();

    const entry = path.join(temporary, 'index.cjs');
    await build({
      absWorkingDir: root,
      bundle: true,
      entryPoints: [path.join(root, 'scripts/elasticsearchReindex/index.ts')],
      outfile: entry,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
      external: ['@electric-sql/pglite', '@electric-sql/pglite/*', 'drizzle-orm', 'drizzle-orm/*'],
      alias: { pg: path.join(import.meta.dirname, 'bootstrapPg.fixture.ts') },
      inject: [
        path.join(root, 'scripts/elasticsearchReindex/__tests__/fixtures/reindexFetch.fixture.ts'),
      ],
    });
    const exits: { code: number; output: string; owner: string | undefined }[] = [];
    const run = async (args: string[], env: NodeJS.ProcessEnv) => {
      const child = spawn(process.execPath, [entry, ...args], {
        cwd: temporary,
        env: {
          ...env,
          NODE_PATH: [
            path.join(root, 'packages/database/node_modules'),
            path.join(root, 'node_modules'),
          ].join(path.delimiter),
          TEST_REINDEX_PGLITE_DIRECTORY: directory,
          TEST_REINDEX_SCHEMA: schemaName,
          ENABLE_TELEMETRY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        timeout: 30_000,
        killSignal: 'SIGKILL',
      });
      children.add(child);
      let output = '';
      child.stdout!.on('data', (data) => {
        output += data;
      });
      child.stderr!.on('data', (data) => {
        output += data;
      });
      child.on(
        'message',
        (request: { type: string; id: number; url: string; method: string; body?: string }) => {
          if (request.type !== 'es-request') return;
          void (async () => {
            try {
              const response = await elasticsearch.fetch(request.url, {
                method: request.method,
                body: request.body,
              });
              if (child.connected)
                child.send({
                  type: 'es-response',
                  id: request.id,
                  body: await response.text(),
                  status: response.status,
                });
            } catch (error) {
              if (child.connected)
                child.send({ type: 'es-response', id: request.id, error: String(error) });
            }
          })();
        },
      );
      const code = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          if (signal) output += `child signal: ${signal}`;
          resolve(code ?? 1);
        });
      });
      children.delete(child);
      // Observe the retained lock after the real child closes, before parent recovery runs.
      exits.push({ code, output, owner: (await lock.read())?.owner });
      return code;
    };
    const options = {
      argv: [
        '--apply',
        '--fresh-run',
        '--yes',
        '--new-tenants-only',
        '--batch-size=1',
        '--max-request-retries=0',
      ],
      environment: {
        ...process.env,
        DATABASE_URL: 'postgres://unused',
        ES_URL: 'http://localhost:9200',
        ES_API_KEY: undefined,
        ES_ALLOW_INSECURE_HTTP: 'true',
        ES_INDEX_NAMESPACE: 'test',
        ES_REINDEX_STATE_DIR: path.join(temporary, 'state'),
        ES_REINDEX_BOOTSTRAP_STALE_LOCK_SECONDS: '4200',
      },
      installCapture: async () => {},
      listDestroyedTenants: async () => [],
      parseTenants: () => [],
      log: vi.fn(),
      run,
      listTargets: async () => [
        {
          tenantId,
          schemaName,
          h24,
          slug: 'test',
          clientConfig: { host: 'unused', database: 'unused', user: runtimeUsername, ssl: false },
        },
      ],
    };
    expect(await runTenantReindex(options)).toBe(1);
    expect(
      elasticsearch.failedBulks,
      JSON.stringify({ exits, requests: elasticsearch.requests }),
    ).toBe(1);
    expect(exits[0].owner).toMatch(/^bootstrap:/);
    const [before] = await listFtsSearchReindexCheckpoints(
      path.join(options.environment.ES_REINDEX_STATE_DIR, h24),
    );
    expect(before.checkpoint.run.status).toBe('backfilling');
    expect(before.checkpoint.progress.find(({ entity }) => entity === 'agents')?.cursor).toBe(
      'agent-1',
    );
    expect(await lock.read()).toBeNull();

    elasticsearch.failSecondBulk = false;
    expect(await runTenantReindex(options)).toBe(0);
    expect(exits[1].code, exits[1].output).toBe(0);
    const [after] = await listFtsSearchReindexCheckpoints(
      path.join(options.environment.ES_REINDEX_STATE_DIR, h24),
    );
    expect(after.checkpoint.run.id).toBe(before.checkpoint.run.id);
    expect(after.checkpoint.run.status).toBe('ready_for_incremental_sync');
    expect(after.checkpoint.progress.every(({ status }) => status === 'completed')).toBe(true);
    expect(elasticsearch.bulkIds).toEqual(['agent-1', 'agent-2']);
    expect(await lock.read()).toBeNull();
  } finally {
    for (const child of children) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('close', () => resolve()));
    }
    if (!pglite.closed) await pglite.close();
    vi.unstubAllGlobals();
    await rm(temporary, { force: true, recursive: true });
  }
}, 120_000);
