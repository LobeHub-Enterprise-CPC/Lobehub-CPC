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
});
