// @vitest-environment node
import { EventEmitter } from 'node:events';

import {
  SUPPORTED_TENANT_SCHEMA_VERSIONS,
  tenantDbNames,
  type TenantPoolManager,
} from '@lobechat/database/tenant';
import { describe, expect, it, vi } from 'vitest';

import { loadTenantPublicEndpoint } from './endpoints';
import { TenantRoutingUnavailableError } from './routingErrors';
import { TENANT_ADMISSION_TTL_MS, TenantRuntime } from './runtime';

vi.mock('./endpoints', () => ({ loadTenantPublicEndpoint: vi.fn() }));
vi.mock('@/server/crypto/tenantKeys', () => ({
  openDirectoryData: () => 'synthetic-test-password',
}));

const activeRow = {
  directory: { status: 'active', tenantId: 't-1' },
  lifecycle: {
    acceptedVersion: 1,
    desiredState: 'active',
    expiresAt: null,
    freezeReasons: [],
  },
};

/** A platform database whose directory reads answer only when the test says so. */
const controlledPlatform = () => {
  const pending: ((rows: unknown[]) => void)[] = [];
  const select = vi.fn(() => {
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      limit: () => new Promise<unknown[]>((resolve) => pending.push(resolve)),
      where: () => chain,
    };
    return chain;
  });
  return { answer: (rows: unknown[]) => pending.shift()!(rows), pending, select };
};

const setup = () => {
  let clock = 1_000_000;
  const platform = controlledPlatform();
  const runtime = new TenantRuntime(
    () => ({ select: platform.select }) as any,
    {} as TenantPoolManager,
    () => new Date(clock),
  );
  return { advance: (ms: number) => (clock += ms), platform, runtime };
};

describe('TenantRuntime.assertAdmitted', () => {
  it('does not let a lookup started before lifecycle invalidation repopulate admission', async () => {
    const { platform, runtime } = setup();
    const old = runtime.assertAdmitted('t-1');
    const refusal = expect(old).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    runtime.invalidate('t-1');
    platform.answer([activeRow]);
    await refusal;
    const next = runtime.assertAdmitted('t-1');
    const frozen = expect(next).rejects.toMatchObject({ code: 'TENANT_FROZEN' });
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    platform.answer([
      { ...activeRow, lifecycle: { ...activeRow.lifecycle, desiredState: 'frozen' } },
    ]);
    await frozen;
  });

  it("keeps other tenants' admission snapshots when one tenant is invalidated", async () => {
    const { platform, runtime } = setup();
    for (const id of ['t-1', 't-2']) {
      const admitted = runtime.assertAdmitted(id);
      await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
      platform.answer([{ ...activeRow, directory: { ...activeRow.directory, tenantId: id } }]);
      await admitted;
    }
    expect(platform.select).toHaveBeenCalledTimes(2);
    runtime.invalidate('t-1');
    await expect(runtime.assertAdmitted('t-2')).resolves.toBeUndefined();
    expect(platform.select).toHaveBeenCalledTimes(2);
    const reloaded = runtime.assertAdmitted('t-1');
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    platform.answer([activeRow]);
    await reloaded;
    expect(platform.select).toHaveBeenCalledTimes(3);
  });

  it('refuses a tenant with a destruction terminal from the barrier on, whatever its lifecycle says', async () => {
    const { platform, runtime } = setup();
    const refused = expect(runtime.assertAdmitted('t-1')).rejects.toMatchObject({
      code: 'TENANT_DESTROYED',
    });
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    platform.answer([{ ...activeRow, destruction: 't-1' }]);
    await refused;
    const gateway = expect(runtime.gatewayAdmission('t-1')).rejects.toMatchObject({
      code: 'TENANT_DESTROYED',
    });
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    platform.answer([{ ...activeRow, destruction: 't-1' }]);
    await gateway;
  });

  it('admits on a read that answered within the admission TTL', async () => {
    const { platform, runtime } = setup();
    const admitted = runtime.assertAdmitted('t-1');
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    platform.answer([activeRow]);
    await expect(admitted).resolves.toBeUndefined();
  });

  it('refuses an "active" answer to a read that started longer ago than the TTL', async () => {
    const { advance, platform, runtime } = setup();
    // The read starts before a freeze is committed and answers after it.
    const admitted = runtime.assertAdmitted('t-1');
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    advance(TENANT_ADMISSION_TTL_MS + 1);
    platform.answer([activeRow]);
    await expect(admitted).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });

    // Not cached as admitted either: the next check reads again.
    const next = runtime.assertAdmitted('t-1');
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    platform.answer([activeRow]);
    await expect(next).resolves.toBeUndefined();
    expect(platform.select).toHaveBeenCalledTimes(2);
  });

  it('does not answer a fresh (maxAge 0) check with a read started earlier', async () => {
    const { advance, platform, runtime } = setup();
    const earlier = runtime.assertAdmitted('t-1');
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    advance(1);
    const fresh = runtime.assertAdmitted('t-1', 0);
    await vi.waitFor(() => expect(platform.select).toHaveBeenCalledTimes(2));

    platform.answer([activeRow]);
    platform.answer([
      { ...activeRow, lifecycle: { ...activeRow.lifecycle, desiredState: 'frozen' } },
    ]);
    await expect(earlier).resolves.toBeUndefined();
    await expect(fresh).rejects.toMatchObject({ code: 'TENANT_FROZEN' });
  });

  it('shares one read among strict checks that arrive while another is running, never an earlier one', async () => {
    const { platform, runtime } = setup();
    const first = runtime.assertAdmitted('t-1', 0);
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    // Four more arrive while the first read is still out: they must not use it.
    const burst = [1, 2, 3, 4].map(() => runtime.assertAdmitted('t-1', 0));
    const burstSettled = Promise.allSettled(burst);
    expect(platform.select).toHaveBeenCalledTimes(1);

    platform.answer([activeRow]);
    await expect(first).resolves.toBeUndefined();
    await vi.waitFor(() => expect(platform.select).toHaveBeenCalledTimes(2));
    platform.answer([
      { ...activeRow, lifecycle: { ...activeRow.lifecycle, desiredState: 'frozen' } },
    ]);

    const results = await burstSettled;
    expect(platform.select).toHaveBeenCalledTimes(2);
    for (const result of results) {
      expect(result).toMatchObject({ reason: { code: 'TENANT_FROZEN' }, status: 'rejected' });
    }
  });

  it('answers an early (TTL) check from the facts a strict read just loaded', async () => {
    const { platform, runtime } = setup();
    const strict = runtime.assertAdmitted('t-1', 0);
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    platform.answer([activeRow]);
    await strict;

    await expect(runtime.assertAdmitted('t-1', TENANT_ADMISSION_TTL_MS)).resolves.toBeUndefined();
    expect(platform.select).toHaveBeenCalledTimes(1);
  });

  it('keeps serving strict checks after a read fails', async () => {
    const { platform, runtime } = setup();
    const failing = runtime.assertAdmitted('t-1', 0);
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    const queued = runtime.assertAdmitted('t-1', 0);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    platform.pending.shift()!(Promise.reject(new Error('platform down')) as never);
    await expect(failing).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });

    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    platform.answer([activeRow]);
    await expect(queued).resolves.toBeUndefined();
  });
});

describe('TenantRuntime.enterTenantId', () => {
  it('preserves a routing unavailable refusal through real runtime admission and releases claims', async () => {
    const platform = controlledPlatform();
    const releaseClaim = vi.fn();
    const releasePool = vi.fn();
    const client = Object.assign(new EventEmitter(), { release: vi.fn() });
    const pools = {
      acquire: vi.fn(() => ({ pool: { connect: async () => client }, release: releasePool })),
    };
    const verify = vi.fn().mockResolvedValue(undefined);
    const runtime = new TenantRuntime(
      () => ({ select: platform.select }) as any,
      pools as never,
      () => new Date(1_000_000),
      { enter: async () => releaseClaim, isHeld: () => true } as never,
      verify,
    );
    const names = tenantDbNames('t-1');
    vi.mocked(loadTenantPublicEndpoint).mockRejectedValueOnce(
      new TenantRoutingUnavailableError('ROUTING_LOAD_EXPIRED'),
    );
    const entering = runtime.enterTenantId('t-1');
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    platform.answer([
      {
        ...activeRow,
        directory: {
          ...activeRow.directory,
          schemaName: names.schemaName,
          runtimeUsername: names.runtimeUsername,
          schemaVersion: [...SUPPORTED_TENANT_SCHEMA_VERSIONS][0],
          connectionVersion: 1,
          credentialBundleVersion: 1,
          runtimeSecret: 'synthetic-envelope',
          database: 'synthetic-test-db',
          host: 'localhost',
          port: 1,
          tls: { enabled: false },
        },
      },
    ]);
    await expect(entering).rejects.toMatchObject({
      code: 'TENANT_UNAVAILABLE',
      reason: 'ROUTING_LOAD_EXPIRED',
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(releaseClaim).toHaveBeenCalledOnce();
    expect(releasePool).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
  });
  // Without claims the runtime refuses after admission, so each entry stops right after
  // its directory read: enough to count platform reads.
  const enter = (runtime: TenantRuntime) =>
    expect(runtime.enterTenantId('t-1')).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });

  it('admits job entries from the shared admission snapshot instead of a read per job', async () => {
    const { platform, runtime } = setup();
    const first = enter(runtime);
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    platform.answer([activeRow]);
    await first;

    await enter(runtime);
    await enter(runtime);
    expect(platform.select).toHaveBeenCalledTimes(1);
  });

  it('reads again once the snapshot is older than the admission TTL', async () => {
    const { advance, platform, runtime } = setup();
    const first = enter(runtime);
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    platform.answer([activeRow]);
    await first;

    advance(TENANT_ADMISSION_TTL_MS);
    const again = runtime.enterTenantId('t-1');
    await vi.waitFor(() => expect(platform.select).toHaveBeenCalledTimes(2));
    platform.answer([
      { ...activeRow, lifecycle: { ...activeRow.lifecycle, desiredState: 'frozen' } },
    ]);
    await expect(again).rejects.toMatchObject({ code: 'TENANT_FROZEN' });
  });
});

describe('TenantRuntime refusal source', () => {
  const answerWith = async (
    runtime: TenantRuntime,
    platform: ReturnType<typeof controlledPlatform>,
    row: unknown,
  ) => {
    const entering = runtime.enterTenantId('t-1');
    entering.catch(() => undefined);
    await vi.waitFor(() => expect(platform.pending).toHaveLength(1));
    platform.answer([row]);
    return entering;
  };

  it.each([
    ['a directory entry that is not active', { ...activeRow, directory: { status: 'pending' } }],
    ['a tenant Console that was never activated', { ...activeRow, lifecycle: null }],
    [
      'a tenant Console at accepted version 0',
      { ...activeRow, lifecycle: { ...activeRow.lifecycle, acceptedVersion: 0 } },
    ],
  ])('marks %s as an admission refusal', async (_name, row) => {
    const { platform, runtime } = setup();
    await expect(answerWith(runtime, platform, row)).rejects.toMatchObject({
      code: 'TENANT_NOT_READY',
      source: 'admission',
    });
  });

  it.each([
    ['offline', { desiredState: 'offline' }, 'TENANT_OFFLINE'],
    ['frozen', { desiredState: 'frozen' }, 'TENANT_FROZEN'],
    ['expired', { expiresAt: new Date(1) }, 'TENANT_EXPIRED'],
  ])('marks a %s tenant as an admission refusal', async (_name, lifecycle, code) => {
    const { platform, runtime } = setup();
    await expect(
      answerWith(runtime, platform, {
        ...activeRow,
        lifecycle: { ...activeRow.lifecycle, ...lifecycle },
      }),
    ).rejects.toMatchObject({ code, source: 'admission' });
  });

  it('marks a database that cannot be opened for an admitted tenant as infrastructure', async () => {
    const platform = controlledPlatform();
    const runtime = new TenantRuntime(
      () => ({ select: platform.select }) as any,
      {} as TenantPoolManager,
      () => new Date(1_000_000),
      { enter: async () => async () => {}, isHeld: () => true } as never,
    );
    // The schema name does not match what the tenant id derives: not a lifecycle refusal.
    const error = await answerWith(runtime, platform, {
      ...activeRow,
      directory: {
        ...activeRow.directory,
        schemaName: 'tenant_wrong',
        runtimeUsername: 'wrong',
        schemaVersion: [...SUPPORTED_TENANT_SCHEMA_VERSIONS][0],
      },
    }).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'TENANT_NOT_READY', source: 'infrastructure' });
  });
});
