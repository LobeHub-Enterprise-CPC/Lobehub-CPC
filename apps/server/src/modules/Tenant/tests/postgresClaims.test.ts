// @vitest-environment node
import { SUPPORTED_TENANT_SCHEMA_VERSIONS, tenantDbNames } from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tenantGateErrorOf } from '../errors';
import { TenantRuntime } from '../runtime';

const state = vi.hoisted(() => ({
  directoryRows: [] as unknown[],
  executeError: undefined as unknown,
}));

vi.mock('@lobechat/database/platform', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const tx = {
    execute: async () => {
      if (state.executeError) throw state.executeError;
    },
    select: () => ({
      from: (table: unknown) => ({
        // The process registration row is read straight from the table; the directory row
        // through the lifecycle join.
        leftJoin: () => ({ where: async () => state.directoryRows }),
        where: async () => (table === original.tenantRuntimeProcess ? [{ state: 'running' }] : []),
      }),
    }),
  };
  const db = {
    delete: () => ({ where: async () => undefined }),
    insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve() }) }),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
  };
  return { ...original, getPlatformDB: () => db };
});

const { tenantClaims } = await import('../postgresClaims');

const row = (directory: object, lifecycle: object | null) => [
  { directory: { status: 'active', ...directory }, lifecycle },
];
const lifecycle = {
  acceptedVersion: 1,
  desiredState: 'active',
  expiresAt: null,
  freezeReasons: [],
};

beforeEach(() => {
  state.directoryRows = row({}, lifecycle);
  state.executeError = undefined;
});

describe('tenant claim acquisition refusals', () => {
  it.each([
    ['a directory entry that is no longer active', row({ status: 'pending' }, lifecycle)],
    ['a tenant Console that was never activated', row({}, null)],
    ['a tenant Console at accepted version 0', row({}, { ...lifecycle, acceptedVersion: 0 })],
  ])('marks %s as an admission refusal', async (_name, rows) => {
    state.directoryRows = rows;
    await expect(tenantClaims.enter('t-1')).rejects.toMatchObject({
      code: 'TENANT_NOT_READY',
      source: 'admission',
    });
  });

  it('keeps the lifecycle refusals admission', async () => {
    state.directoryRows = row({}, { ...lifecycle, desiredState: 'frozen' });
    await expect(tenantClaims.enter('t-1')).rejects.toMatchObject({
      code: 'TENANT_FROZEN',
      source: 'admission',
    });
  });

  it('keeps a missing directory row exactly as it was: not ready, not an admission refusal', async () => {
    state.directoryRows = [];
    await expect(tenantClaims.enter('t-1')).rejects.toMatchObject({
      code: 'TENANT_NOT_READY',
      source: 'infrastructure',
    });
  });

  it('leaves a real database failure an infrastructure failure', async () => {
    state.executeError = new Error('connection terminated');
    const error = await tenantClaims.enter('t-1').catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(tenantGateErrorOf(error)?.source).not.toBe('admission');
  });

  it('is an admission refusal at the runtime when the directory read before it still said active', async () => {
    const names = tenantDbNames('t-1');
    const activeDirectoryRead = {
      directory: {
        status: 'active',
        tenantId: 't-1',
        schemaName: names.schemaName,
        runtimeUsername: names.runtimeUsername,
        schemaVersion: [...SUPPORTED_TENANT_SCHEMA_VERSIONS][0],
      },
      lifecycle,
    };
    const select = vi.fn(() => {
      const chain = {
        from: () => chain,
        leftJoin: () => chain,
        limit: async () => [activeDirectoryRead],
        where: () => chain,
      };
      return chain;
    });
    const runtime = new TenantRuntime(
      () => ({ select }) as never,
      {} as never,
      () => new Date(1_000_000),
      tenantClaims,
    );
    // The claim's own, newer read sees the directory entry deactivated.
    state.directoryRows = row({ status: 'pending' }, lifecycle);
    await expect(runtime.enterTenantId('t-1')).rejects.toMatchObject({
      code: 'TENANT_NOT_READY',
      source: 'admission',
    });
  });
});
