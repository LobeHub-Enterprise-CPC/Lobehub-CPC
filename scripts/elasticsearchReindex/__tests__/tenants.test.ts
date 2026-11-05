// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TenantDatabaseTarget } from '../../../apps/server/src/services/tenantControlPlane/tenantDatabases';
import { tenantFtsSearchNamespace } from '../../../packages/database/src/tenant/names';
import { runTenantReindex, tenantDatabaseUrl } from '../tenants';

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
const tempDirectory = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fts-tenants-'));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
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

    it('installs capture and backfills only tenants that have no checkpoint yet', async () => {
      const state = await tempDirectory();
      // Already backfilled: a checkpoint exists.
      await mkdir(path.join(state, 'aaa'));
      await writeFile(path.join(state, 'aaa', 'reindex-cpc-mt-a-0123456789ab-v1.json'), '{}');
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
          listTargets: vi
            .fn()
            .mockResolvedValue([target('a', 'aaa'), target('b', 'bbb'), target('c', 'ccc')]),
          log: vi.fn(),
          parseTenants: () => [],
          run,
        }),
      ).resolves.toBe(0);

      expect(installCapture.mock.calls).toEqual([['b'], ['c']]);
      expect(run.mock.calls.map(([, childEnv]) => childEnv.ES_INDEX_NAMESPACE)).toEqual([
        tenantFtsSearchNamespace('cpc-mt', 'b'),
        tenantFtsSearchNamespace('cpc-mt', 'c'),
      ]);
      expect(run.mock.calls[0][0]).toEqual(['--apply', '--fresh-run', '--yes']);
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
