// @vitest-environment node
import type { TenantPoolManager } from '@lobechat/database/tenant';
import { describe, expect, it, vi } from 'vitest';

import { TENANT_ADMISSION_TTL_MS, TenantRuntime } from '../runtime';

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
