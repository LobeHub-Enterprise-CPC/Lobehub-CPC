// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantDatabaseTarget } from '../../../apps/server/src/services/tenantControlPlane/tenantDatabases';
import { tenantFtsSearchNamespace, tenantHash } from '../../../packages/database/src/tenant/names';
import { StatefulElasticsearch } from '../runtime/__tests__/migrationLock.testUtils';
import { FtsSearchReindexFileRepository } from '../runtime/checkpointRepository';
import { FtsSearchMigrationLockClient } from '../runtime/migrationLock';
import { deleteNamespaceIndices, runTenantReindex, tenantDatabaseUrl } from '../tenants';

const target = (tenantId: string, h24: string): TenantDatabaseTarget => ({
  clientConfig: {
    database: 'lobehub',
    host: 'db.internal',
    options: `-c search_path=tenant_${h24},extensions,paradedb`,
    password: 'p@ss/word',
    port: 6432,
    ssl: false,
    user: `lh_${h24}_run`,
  },
  h24,
  schemaName: `tenant_${h24}`,
  slug: tenantId,
  tenantId,
});

const directories: string[] = [];
let elasticsearch: StatefulElasticsearch;
beforeEach(() => {
  elasticsearch = new StatefulElasticsearch();
  vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
  vi.stubEnv('ES_URL', 'http://localhost:9200');
  vi.stubEnv('ES_ALLOW_INSECURE_HTTP', 'true');
  vi.stubEnv('ES_REINDEX_BOOTSTRAP_STALE_LOCK_SECONDS', '4200');
});
const tempDirectory = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fts-tenants-'));
  directories.push(directory);
  return directory;
};

const checkpoint = async (state: string, tenantId: string, h24: string, ready = true) => {
  const repository = new FtsSearchReindexFileRepository({
    readCaptureFingerprint: async () => 'capture',
    readHighWaterRevision: async () => 1,
    reserveRevisionWithWriteFence: async () => 1,
    stateDirectory: path.join(state, h24),
  });
  const result = await repository.createOrResume(tenantFtsSearchNamespace('cpc-mt', tenantId), 1);
  if (ready) {
    for (const progress of result.progress)
      await repository.completeEntity(result.run.id, progress.entity);
    await repository.markReadyForIncrementalSync(
      result.run.id,
      result.progress.map(({ entity }) => entity),
    );
  }
  return repository;
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

describe('runTenantReindex', () => {
  it("runs the reindex once per tenant with the tenant's database, namespace and checkpoints", async () => {
    const state = await tempDirectory();
    const run = vi.fn().mockResolvedValue(0);
    const listTargets = vi.fn().mockResolvedValue([target('a', 'aaa'), target('b', 'bbb')]);

    await expect(
      runTenantReindex({
        argv: ['--startup', '--tenant', 'a', '--tenant=b', '--yes'],
        environment: { ...process.env, ES_INDEX_NAMESPACE: 'lobehub', ES_REINDEX_STATE_DIR: state },
        listTargets,
        log: vi.fn(),
        parseTenants: () => ['a', 'b'],
        run,
      }),
    ).resolves.toBe(0);

    expect(listTargets).toHaveBeenCalledWith(['a', 'b']);
    expect(run).toHaveBeenCalledTimes(2);
    const [args, childEnv] = run.mock.calls[0];
    expect(args).toEqual(['--startup', '--yes']);
    expect(childEnv.ES_INDEX_NAMESPACE).toBe(tenantFtsSearchNamespace('lobehub', 'a'));
    expect(childEnv.ES_REINDEX_STATE_DIR).toBe(path.join(state, 'aaa'));
    const url = new URL(childEnv.DATABASE_URL);
    expect(url.searchParams.get('options')).toBe('-c search_path=tenant_aaa,extensions,paradedb');
    expect(decodeURIComponent(url.password)).toBe('p@ss/word');
    expect(run.mock.calls[1][1].ES_INDEX_NAMESPACE).toBe(tenantFtsSearchNamespace('lobehub', 'b'));
  });

  it('keeps going past a failing tenant and fails afterwards', async () => {
    const run = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      runTenantReindex({
        argv: ['--status'],
        environment: { ...process.env, ES_INDEX_NAMESPACE: 'lobehub' },
        listTargets: vi.fn().mockResolvedValue([target('a', 'aaa'), target('b', 'bbb')]),
        log: vi.fn(),
        parseTenants: () => [],
        run,
      }),
    ).resolves.toBe(1);

    expect(run).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('❌ Elasticsearch reindex failed for tenants: %s', 'a');
    error.mockRestore();
  });

  describe('--new-tenants-only', () => {
    const argv = ['--apply', '--fresh-run', '--yes', '--new-tenants-only'];
    const namespace = tenantFtsSearchNamespace('cpc-mt', 'a');
    const owner = 'bootstrap:00000000-0000-4000-8000-000000000001';
    const client = (ns = namespace, token?: string) =>
      new FtsSearchMigrationLockClient({
        namespace: ns,
        owner: token,
        allowInsecureHttp: true,
        url: 'http://localhost:9200',
      });
    const lock = async (token = owner, ageSeconds = 5000) => {
      await client(namespace, token).acquire('apply');
      elasticsearch.indexes.get(`${namespace}-fts-search-control`)!.document!.source.acquiredAt =
        new Date(Date.now() - ageSeconds * 1000).toISOString();
    };
    const options = async (pending = false) => {
      const state = await tempDirectory();
      if (pending) await checkpoint(state, 'a', 'aaa', false);
      return {
        argv,
        environment: {
          ...process.env,
          ES_REINDEX_BOOTSTRAP_STALE_LOCK_SECONDS:
            process.env.ES_REINDEX_BOOTSTRAP_STALE_LOCK_SECONDS,
          ES_INDEX_NAMESPACE: 'cpc-mt',
          ES_REINDEX_STATE_DIR: state,
        },
        installCapture: vi.fn(),
        listDestroyedTenants: async () => [],
        listTargets: async () => [target('a', 'aaa')],
        parseTenants: () => [],
        log: vi.fn(),
      };
    };

    it('releases only its exact exited child owner after checking namespace tasks, keeping this round failed', async () => {
      const opts = await options();
      let childOwner: string | undefined;
      const run = vi.fn(async (_args, environment) => {
        childOwner = environment.ES_REINDEX_LOCK_OWNER;
        expect(childOwner).toMatch(
          /^bootstrap:[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
        );
        await client(namespace, childOwner).acquire('apply');
        return 1;
      });
      expect(await runTenantReindex({ ...opts, run })).toBe(1);
      expect(childOwner).toBeDefined();
      expect(await client().read()).toBeNull();
      expect(elasticsearch.requests.some(({ pathname }) => pathname.startsWith('/_tasks?'))).toBe(
        true,
      );
      expect(opts.log.mock.calls.flat().join(' ')).toContain(childOwner);
    });

    it.each(['indices:data/write/bulk', 'indices:admin/create'])(
      'retains the exited child lock while %s tasks involve the namespace',
      async (action) => {
        const opts = await options();
        const run = vi.fn(async (_args, environment) => {
          await client(namespace, environment.ES_REINDEX_LOCK_OWNER).acquire('apply');
          elasticsearch.tasks = {
            nodes: {
              node: {
                tasks: { 'node:1': { action, description: `indices[${namespace}-agents-v1]` } },
              },
            },
          };
          return 1;
        });
        expect(await runTenantReindex({ ...opts, run })).toBe(1);
        expect(await client().read()).not.toBeNull();
        expect(elasticsearch.requests.some(({ method }) => method === 'DELETE')).toBe(false);
      },
    );

    it('never releases a lock belonging to a different owner after a failed child', async () => {
      const opts = await options();
      const run = vi.fn(async () => {
        await client().acquire('manual apply');
        return 1;
      });
      expect(await runTenantReindex({ ...opts, run })).toBe(1);
      expect(elasticsearch.requests.some(({ method }) => method === 'DELETE')).toBe(false);
      expect(elasticsearch.requests.some(({ pathname }) => pathname.startsWith('/_tasks?'))).toBe(
        false,
      );
    });

    it.each([false, true])(
      'recovers an expired bootstrap lock before starting a child (checkpoint=%s)',
      async (pending) => {
        const opts = await options(pending);
        await lock();
        const run = vi.fn(async (args, environment) => {
          expect(await client().read()).toBeNull();
          expect(args.includes('--fresh-run')).toBe(!pending);
          expect(environment.ES_REINDEX_LOCK_OWNER).not.toBe(owner);
          return 0;
        });
        expect(await runTenantReindex({ ...opts, run })).toBe(0);
        expect(run).toHaveBeenCalledOnce();
        expect(elasticsearch.requests.some(({ method }) => method === 'DELETE')).toBe(true);
      },
    );

    it.each(['recent', 'manual', 'busy'])(
      'keeps a %s lock, fails this tenant and still runs other tenants',
      async (kind) => {
        const opts = await options(true);
        if (kind === 'manual') await client().acquire('manual apply');
        else await lock(owner, kind === 'recent' ? 1 : 5000);
        if (kind === 'busy')
          elasticsearch.tasks = {
            nodes: {
              node: {
                tasks: {
                  'node:1': {
                    action: 'indices:data/write/bulk',
                    description: `indices[${namespace}-agents-v1]`,
                  },
                },
              },
            },
          };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const run = vi.fn(async (_args: string[], _environment: NodeJS.ProcessEnv) => 0);
        expect(
          await runTenantReindex({
            ...opts,
            listTargets: async () => [target('a', 'aaa'), target('b', 'bbb')],
            run,
          }),
        ).toBe(1);
        expect(run).toHaveBeenCalledOnce();
        expect(run.mock.calls[0][1].ES_INDEX_NAMESPACE).toBe(
          tenantFtsSearchNamespace('cpc-mt', 'b'),
        );
        expect(elasticsearch.requests.some(({ method }) => method === 'DELETE')).toBe(false);
        const messages = error.mock.calls.flat().join(' ');
        expect(messages).toContain('acquired');
        expect(messages).toContain('--release-lock=');
        expect(messages).toContain('--yes');
      },
    );

    it.each(['tasks', 'read', 'release'])(
      'fails closed when %s fails during stale lock recovery',
      async (failure) => {
        const opts = await options(true);
        await lock();
        if (failure === 'tasks') elasticsearch.tasksStatus = 503;
        if (failure === 'read') elasticsearch.lockReadStatus = 503;
        if (failure === 'release')
          elasticsearch.beforeNextDelete = () => {
            throw new Error('connection dropped');
          };
        const run = vi.fn();
        expect(await runTenantReindex({ ...opts, run })).toBe(1);
        expect(run).not.toHaveBeenCalled();
        expect(
          elasticsearch.indexes.get(`${namespace}-fts-search-control`)!.document,
        ).toBeDefined();
      },
    );

    it('does not release a failed child lock when the task query fails', async () => {
      const opts = await options();
      const run = vi.fn(async (_args, environment) => {
        await client(namespace, environment.ES_REINDEX_LOCK_OWNER).acquire('apply');
        elasticsearch.tasksStatus = 503;
        return 1;
      });
      expect(await runTenantReindex({ ...opts, run })).toBe(1);
      expect(elasticsearch.requests.some(({ method }) => method === 'DELETE')).toBe(false);
      expect(await client().read()).not.toBeNull();
    });

    it.each([undefined, '', '0', '-1', '1.5', '1e3', '9007199254740992', '4200\n'])(
      'requires a positive integer bootstrap stale threshold (%j)',
      async (value) => {
        const opts = await options();
        opts.environment.ES_REINDEX_BOOTSTRAP_STALE_LOCK_SECONDS = value;
        const listTargets = vi.fn();
        await expect(runTenantReindex({ ...opts, listTargets, run: vi.fn() })).rejects.toThrow(
          'ES_REINDEX_BOOTSTRAP_STALE_LOCK_SECONDS',
        );
        expect(listTargets).not.toHaveBeenCalled();
      },
    );

    it('leaves manual --tenant commands unmarked and never attempts automatic recovery', async () => {
      const opts = await options(true);
      await lock();
      elasticsearch.requests.length = 0;
      opts.environment.ES_REINDEX_BOOTSTRAP_STALE_LOCK_SECONDS = undefined;
      const run = vi.fn(async (_args, environment) => {
        expect(environment.ES_REINDEX_LOCK_OWNER).toBeUndefined();
        return 1;
      });
      expect(
        await runTenantReindex({ ...opts, argv: ['--apply', '--yes', '--tenant=a'], run }),
      ).toBe(1);
      expect(run).toHaveBeenCalledOnce();
      expect(elasticsearch.requests).toEqual([]);
    });

    it('removes an inherited bootstrap owner from manual child environments without mutating the parent', async () => {
      const opts = await options();
      const environment = { ...opts.environment, ES_REINDEX_LOCK_OWNER: owner };
      const run = vi.fn(async (_args, childEnvironment) => {
        expect(childEnvironment).not.toHaveProperty('ES_REINDEX_LOCK_OWNER');
        return 0;
      });
      expect(
        await runTenantReindex({
          ...opts,
          environment,
          argv: ['--apply', '--yes', '--tenant=a'],
          run,
        }),
      ).toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(environment.ES_REINDEX_LOCK_OWNER).toBe(owner);
      expect(elasticsearch.requests).toEqual([]);
    });

    it('recovers a stale bootstrap lock after all checkpoints are ready without launching a child', async () => {
      const opts = await options();
      await checkpoint(opts.environment.ES_REINDEX_STATE_DIR, 'a', 'aaa');
      await lock();
      const run = vi.fn();
      expect(await runTenantReindex({ ...opts, run })).toBe(0);
      expect(run).not.toHaveBeenCalled();
      expect(await client().read()).toBeNull();
      expect(opts.installCapture).toHaveBeenCalledExactlyOnceWith('a');
      expect(opts.log.mock.calls.flat().join(' ')).toContain('Recovered migration lock');
      expect(opts.log.mock.calls.flat().join(' ')).toContain(owner);
    });

    it.each(['absent', 'manual', 'recent'])(
      'does not fail or reindex completed tenants with %s locks',
      async (kind) => {
        const opts = await options();
        await checkpoint(opts.environment.ES_REINDEX_STATE_DIR, 'a', 'aaa');
        if (kind === 'manual') await client().acquire('manual apply');
        if (kind === 'recent') await lock(owner, 1);
        elasticsearch.requests.length = 0;
        const run = vi.fn();
        expect(await runTenantReindex({ ...opts, run })).toBe(0);
        expect(run).not.toHaveBeenCalled();
        expect(opts.installCapture).toHaveBeenCalledExactlyOnceWith('a');
        expect(
          elasticsearch.requests.some(
            ({ method, pathname }) => method === 'DELETE' || pathname.startsWith('/_tasks?'),
          ),
        ).toBe(false);
        // A held lock is logged; an absent one stays silent (this runs every minute per tenant).
        if (kind !== 'absent')
          expect(opts.log.mock.calls.flat().join(' ')).toContain('migration lock');
        expect(opts.log).toHaveBeenCalledTimes(kind === 'absent' ? 1 : 2);
        expect(
          elasticsearch.indexes.get(`${namespace}-fts-search-control`)?.document !== undefined,
        ).toBe(kind !== 'absent');
      },
    );

    it.each(['read', 'tasks', 'release', 'busy'])(
      'keeps completed-tenant recovery failed when %s cannot prove safe release',
      async (failure) => {
        const opts = await options();
        await checkpoint(opts.environment.ES_REINDEX_STATE_DIR, 'a', 'aaa');
        await lock();
        if (failure === 'read') elasticsearch.lockReadStatus = 503;
        if (failure === 'tasks') elasticsearch.tasksStatus = 503;
        if (failure === 'release')
          elasticsearch.beforeNextDelete = () => {
            throw new Error('connection dropped');
          };
        if (failure === 'busy')
          elasticsearch.tasks = {
            nodes: {
              node: {
                tasks: {
                  'node:1': {
                    action: 'indices:data/write/bulk',
                    description: `indices[${namespace}-agents-v1]`,
                  },
                },
              },
            },
          };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const run = vi.fn();
        expect(await runTenantReindex({ ...opts, run })).toBe(1);
        expect(run).not.toHaveBeenCalled();
        expect(
          elasticsearch.indexes.get(`${namespace}-fts-search-control`)!.document,
        ).toBeDefined();
        expect(error.mock.calls.flat().join(' ')).toContain('tenant');
      },
    );

    it('requires --yes before any bootstrap lock recovery or tenant work', async () => {
      const opts = await options(true);
      await lock();
      elasticsearch.requests.length = 0;
      const listTargets = vi.fn();
      await expect(
        runTenantReindex({
          ...opts,
          argv: argv.filter((arg) => arg !== '--yes'),
          listTargets,
          run: vi.fn(),
        }),
      ).rejects.toThrow('--yes');
      expect(listTargets).not.toHaveBeenCalled();
      expect(elasticsearch.requests).toEqual([]);
    });

    it('does not take over a bootstrap lock exactly at the stale threshold', async () => {
      const opts = await options(true);
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-06T12:00:00.000Z'));
      await lock(owner, 4200);
      const run = vi.fn();
      expect(await runTenantReindex({ ...opts, run })).toBe(1);
      expect(run).not.toHaveBeenCalled();
      expect(elasticsearch.requests.some(({ method }) => method === 'DELETE')).toBe(false);
    });

    it.each(['read', 'release'])(
      'keeps a failed child failed when lock %s fails',
      async (failure) => {
        const opts = await options();
        const run = vi.fn(async (_args, environment) => {
          await client(namespace, environment.ES_REINDEX_LOCK_OWNER).acquire('apply');
          if (failure === 'read') elasticsearch.lockReadStatus = 503;
          else
            elasticsearch.beforeNextDelete = () => {
              throw new Error('connection dropped');
            };
          return 1;
        });
        expect(await runTenantReindex({ ...opts, run })).toBe(1);
        expect(
          elasticsearch.indexes.get(`${namespace}-fts-search-control`)!.document,
        ).toBeDefined();
      },
    );

    it('does no capture, Elasticsearch or child work when there are no tenants to process', async () => {
      const state = await tempDirectory();
      const installCapture = vi.fn();
      const deleteIndices = vi.fn();
      const run = vi.fn();
      await expect(
        runTenantReindex({
          argv,
          environment: {
            ...process.env,
            ES_INDEX_NAMESPACE: 'cpc-mt',
            ES_REINDEX_STATE_DIR: state,
          },
          installCapture,
          deleteIndices,
          listDestroyedTenants: async () => [],
          listTargets: async () => [],
          parseTenants: () => [],
          log: vi.fn(),
          run,
        }),
      ).resolves.toBe(0);
      expect(installCapture).not.toHaveBeenCalled();
      expect(deleteIndices).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it('checks capture for every tenant and only backfills unfinished tenants', async () => {
      const state = await tempDirectory();
      await checkpoint(state, 'a', 'aaa');
      // Only the database CA left by an earlier attempt: still a new tenant.
      await mkdir(path.join(state, 'ccc'));
      await writeFile(path.join(state, 'ccc', 'database-ca.pem'), 'CA');
      const run = vi.fn().mockResolvedValue(0);
      const installCapture = vi.fn().mockResolvedValue(undefined);

      await expect(
        runTenantReindex({
          argv,
          environment: {
            ...process.env,
            ES_INDEX_NAMESPACE: 'cpc-mt',
            ES_REINDEX_STATE_DIR: state,
          },
          installCapture,
          listDestroyedTenants: async () => [],
          listTargets: vi
            .fn()
            .mockResolvedValue([target('a', 'aaa'), target('b', 'bbb'), target('c', 'ccc')]),
          log: vi.fn(),
          parseTenants: () => [],
          run,
        }),
      ).resolves.toBe(0);

      expect(installCapture.mock.calls).toEqual([['a'], ['b'], ['c']]);
      expect(run.mock.calls.map(([, childEnv]) => childEnv.ES_INDEX_NAMESPACE)).toEqual([
        tenantFtsSearchNamespace('cpc-mt', 'b'),
        tenantFtsSearchNamespace('cpc-mt', 'c'),
      ]);
      expect(run.mock.calls[0][0]).toEqual(['--apply', '--fresh-run', '--yes']);
    });

    it('resumes an unfinished checkpoint without passing --fresh-run', async () => {
      const state = await tempDirectory();
      await checkpoint(state, 'a', 'aaa', false);
      const run = vi.fn().mockResolvedValue(0);
      await expect(
        runTenantReindex({
          argv,
          environment: {
            ...process.env,
            ES_INDEX_NAMESPACE: 'cpc-mt',
            ES_REINDEX_STATE_DIR: state,
          },
          installCapture: vi.fn(),
          listDestroyedTenants: async () => [],
          listTargets: async () => [target('a', 'aaa')],
          parseTenants: () => [],
          log: vi.fn(),
          run,
        }),
      ).resolves.toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0][0]).toEqual(['--apply', '--yes']);
    });

    it('repairs capture even for a completed tenant, without starting a reindex or writing files', async () => {
      const state = await tempDirectory();
      await checkpoint(state, 'a', 'aaa');
      const before = await stat(path.join(state, 'aaa'));
      const installCapture = vi.fn();
      const run = vi.fn();
      await expect(
        runTenantReindex({
          argv,
          environment: {
            ...process.env,
            ES_INDEX_NAMESPACE: 'cpc-mt',
            ES_REINDEX_STATE_DIR: state,
          },
          installCapture,
          listDestroyedTenants: async () => [],
          listTargets: async () => [target('a', 'aaa')],
          parseTenants: () => [],
          log: vi.fn(),
          run,
        }),
      ).resolves.toBe(0);
      expect(installCapture).toHaveBeenCalledExactlyOnceWith('a');
      expect(run).not.toHaveBeenCalled();
      expect((await stat(path.join(state, 'aaa'))).mtimeMs).toBe(before.mtimeMs);
    });

    it('reports tampered capture on a completed tenant and continues checking the others', async () => {
      const state = await tempDirectory();
      await checkpoint(state, 'a', 'aaa');
      const run = vi.fn().mockResolvedValue(0);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(
        runTenantReindex({
          argv,
          environment: {
            ...process.env,
            ES_INDEX_NAMESPACE: 'cpc-mt',
            ES_REINDEX_STATE_DIR: state,
          },
          installCapture: vi
            .fn()
            .mockRejectedValueOnce(
              new Error(
                'Refusing to replace partial or unknown FTS search sync capture infrastructure: function capture_fts_search_sync_change',
              ),
            )
            .mockResolvedValue(undefined),
          listDestroyedTenants: async () => [],
          listTargets: async () => [target('a', 'aaa'), target('b', 'bbb')],
          parseTenants: () => [],
          log: vi.fn(),
          run,
        }),
      ).resolves.toBe(1);
      expect(run).toHaveBeenCalledOnce();
      expect(error.mock.calls.flat().join(' ')).toContain('Refusing to replace partial or unknown');
      error.mockRestore();
    });

    it('fails closed on corrupt checkpoints instead of silently skipping or overwriting them', async () => {
      const state = await tempDirectory();
      await mkdir(path.join(state, 'aaa'));
      const file = path.join(state, 'aaa', 'reindex-broken.json');
      await writeFile(file, '{}');
      const run = vi.fn();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(
        runTenantReindex({
          argv,
          environment: {
            ...process.env,
            ES_INDEX_NAMESPACE: 'cpc-mt',
            ES_REINDEX_STATE_DIR: state,
          },
          installCapture: vi.fn(),
          listDestroyedTenants: async () => [],
          listTargets: async () => [target('a', 'aaa')],
          parseTenants: () => [],
          log: vi.fn(),
          run,
        }),
      ).resolves.toBe(1);
      expect(run).not.toHaveBeenCalled();
      expect(await readFile(file, 'utf8')).toBe('{}');
      expect(error.mock.calls.flat().join(' ')).toContain('checkpoint');
      error.mockRestore();
    });

    it('does not backfill a tenant whose capture installation failed', async () => {
      const state = await tempDirectory();
      const run = vi.fn().mockResolvedValue(0);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(
        runTenantReindex({
          argv,
          environment: {
            ...process.env,
            ES_INDEX_NAMESPACE: 'cpc-mt',
            ES_REINDEX_STATE_DIR: state,
          },
          installCapture: vi
            .fn()
            .mockRejectedValueOnce(new Error('lock timeout'))
            .mockResolvedValueOnce(undefined),
          listDestroyedTenants: async () => [],
          listTargets: vi.fn().mockResolvedValue([target('a', 'aaa'), target('b', 'bbb')]),
          log: vi.fn(),
          parseTenants: () => [],
          run,
        }),
      ).resolves.toBe(1);

      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][1].ES_INDEX_NAMESPACE).toBe(tenantFtsSearchNamespace('cpc-mt', 'b'));
      expect(error).toHaveBeenCalledWith('❌ Elasticsearch reindex failed for tenants: %s', 'a');
      error.mockRestore();
    });

    it('removes the indices and checkpoints of destroyed tenants, never those of live ones', async () => {
      const state = await tempDirectory();
      const destroyedState = path.join(state, tenantHash('gone'));
      await mkdir(destroyedState);
      await writeFile(path.join(destroyedState, 'reindex-x-v1.json'), '{}');
      await checkpoint(state, 'a', 'aaa');
      const deleteIndices = vi.fn().mockResolvedValue(['cpc-mt-x-messages-v1']);

      await expect(
        runTenantReindex({
          argv,
          deleteIndices,
          environment: {
            ...process.env,
            ES_INDEX_NAMESPACE: 'cpc-mt',
            ES_REINDEX_STATE_DIR: state,
          },
          installCapture: vi.fn(),
          // A live tenant reported as destroyed (an inconsistent read) is left alone.
          listDestroyedTenants: async () => ['gone', 'a'],
          listTargets: vi.fn().mockResolvedValue([target('a', 'aaa')]),
          log: vi.fn(),
          parseTenants: () => [],
          run: vi.fn().mockResolvedValue(0),
        }),
      ).resolves.toBe(0);

      expect(deleteIndices.mock.calls).toEqual([[tenantFtsSearchNamespace('cpc-mt', 'gone')]]);
      await expect(stat(destroyedState)).rejects.toThrow('ENOENT');
      await expect(stat(path.join(state, 'aaa'))).resolves.toBeTruthy();
    });

    it('fails the run when a destroyed tenant cannot be cleaned up, after the other tenants', async () => {
      const state = await tempDirectory();
      const run = vi.fn().mockResolvedValue(0);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(
        runTenantReindex({
          argv,
          deleteIndices: vi.fn().mockRejectedValue(new Error('403')),
          environment: {
            ...process.env,
            ES_INDEX_NAMESPACE: 'cpc-mt',
            ES_REINDEX_STATE_DIR: state,
          },
          installCapture: vi.fn().mockResolvedValue(undefined),
          listDestroyedTenants: async () => ['gone'],
          listTargets: vi.fn().mockResolvedValue([target('b', 'bbb')]),
          log: vi.fn(),
          parseTenants: () => [],
          run,
        }),
      ).resolves.toBe(1);

      expect(run).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith('❌ Elasticsearch reindex failed for tenants: %s', 'gone');
      error.mockRestore();
    });

    it.each([
      ['without the checkpoint directory', argv, undefined],
      ['without --fresh-run', ['--apply', '--yes', '--new-tenants-only'], 'state'],
    ])('refuses to run %s', async (_name, args, stateDirectory) => {
      const run = vi.fn();
      await expect(
        runTenantReindex({
          argv: args,
          environment: {
            ...process.env,
            ES_INDEX_NAMESPACE: 'cpc-mt',
            ES_REINDEX_STATE_DIR: stateDirectory && (await tempDirectory()),
          },
          installCapture: vi.fn(),
          listTargets: vi.fn().mockResolvedValue([target('a', 'aaa')]),
          parseTenants: () => [],
          run,
        }),
      ).rejects.toThrow('--new-tenants-only');
      expect(run).not.toHaveBeenCalled();
    });
  });

  it('requires the base index namespace', async () => {
    await expect(
      runTenantReindex({
        argv: [],
        environment: { ...process.env, ES_INDEX_NAMESPACE: undefined },
        listTargets: vi.fn(),
        parseTenants: () => [],
      }),
    ).rejects.toThrow('ES_INDEX_NAMESPACE is required');
  });
});

describe('tenantDatabaseUrl', () => {
  it('maps TLS settings and writes a custom CA to a private file', async () => {
    const state = await tempDirectory();
    const url = new URL(
      await tenantDatabaseUrl(
        { ...target('a', 'aaa').clientConfig, ssl: { ca: 'CA-PEM', rejectUnauthorized: true } },
        state,
      ),
    );

    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    const caPath = url.searchParams.get('sslrootcert')!;
    await expect(readFile(caPath, 'utf8')).resolves.toBe('CA-PEM');
    expect((await stat(caPath)).mode & 0o777).toBe(0o600);

    const insecure = new URL(
      await tenantDatabaseUrl(
        { ...target('a', 'aaa').clientConfig, ssl: { rejectUnauthorized: false } },
        state,
      ),
    );
    expect(insecure.searchParams.get('sslmode')).toBe('no-verify');
    expect(
      new URL(await tenantDatabaseUrl(target('a', 'aaa').clientConfig, state)).searchParams.get(
        'sslmode',
      ),
    ).toBe('disable');
  });
});

describe('deleteNamespaceIndices', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deletes by exact name only the indices under the namespace, control index included', async () => {
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit = {}) => {
        calls.push({ method: init.method ?? 'GET', url: url.toString() });
        if (!init.method)
          return Response.json({
            aliases: [{ indices: ['cpc-mt-abc-messages-v1'], name: 'cpc-mt-abc-messages' }],
            data_streams: [],
            indices: [
              { name: 'cpc-mt-abc-messages-v1' },
              { name: 'cpc-mt-abc-fts-search-control' },
              // Not under `cpc-mt-abc-`: a server-side match is never trusted alone.
              { name: 'cpc-mt-abcd-messages-v1' },
            ],
          });
        return Response.json({ acknowledged: true });
      }),
    );

    await expect(
      deleteNamespaceIndices('cpc-mt-abc', [], {
        ES_API_KEY: 'key',
        ES_URL: 'https://es.internal:9200',
      }),
    ).resolves.toEqual(['cpc-mt-abc-messages-v1', 'cpc-mt-abc-fts-search-control']);
    expect(calls).toEqual([
      {
        method: 'GET',
        url: 'https://es.internal:9200/_resolve/index/cpc-mt-abc-*?expand_wildcards=all',
      },
      { method: 'DELETE', url: 'https://es.internal:9200/cpc-mt-abc-messages-v1' },
      { method: 'DELETE', url: 'https://es.internal:9200/cpc-mt-abc-fts-search-control' },
    ]);
  });

  it('fails when Elasticsearch refuses a deletion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init: RequestInit = {}) =>
        init.method
          ? new Response('forbidden', { status: 403 })
          : Response.json({ indices: [{ name: 'cpc-mt-abc-messages-v1' }] }),
      ),
    );

    await expect(
      deleteNamespaceIndices('cpc-mt-abc', [], {
        ES_API_KEY: 'key',
        ES_URL: 'https://es.internal:9200',
      }),
    ).rejects.toThrow('cpc-mt-abc-messages-v1 (403)');
  });
});
