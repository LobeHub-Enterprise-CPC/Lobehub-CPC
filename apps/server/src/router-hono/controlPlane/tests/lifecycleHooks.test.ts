import { describe, expect, it, vi } from 'vitest';

import { TenantGateError } from '@/server/modules/Tenant/errors';

import { createLifecycleHooks } from '../lifecycleHooks';

const setup = (refusal: TenantGateError | null = new TenantGateError('TENANT_FROZEN')) => {
  let clock = 1000;
  const calls: string[] = [];
  const deps = {
    waitForClaims: vi.fn(async (id: string) => void calls.push(`claims:${id}`)),
    invalidateAuth: vi.fn((id: string) => calls.push(`auth:${id}`)),
    live: {
      resume: vi.fn(async (id: string) => void calls.push(`resume:${id}`)),
      suspend: vi.fn(async (id: string, reason: TenantGateError) => {
        calls.push(`suspend:${id}:${reason.code}`);
      }),
    },
    now: () => clock,
    propagationMs: 6000,
    runtime: {
      assertAdmitted: vi.fn(async () => {
        if (refusal) throw refusal;
      }),
      drainTransactions: vi.fn(async (id: string) => void calls.push(`drain:${id}@${clock}`)),
      invalidate: vi.fn((id: string) => calls.push(`invalidate:${id}`)),
    },
    sleep: vi.fn(async (ms: number) => {
      calls.push(`sleep:${ms}`);
      clock += ms;
    }),
  };
  return { calls, deps, hooks: createLifecycleHooks(deps) };
};

describe('control-plane lifecycle hooks', () => {
  it('closes local live resources with the refusal, then waits for every process', async () => {
    const { calls, deps, hooks } = setup(new TenantGateError('TENANT_OFFLINE'));
    await hooks.invalidateCaches('t');
    await hooks.closeRealtime('t');
    expect(deps.runtime.assertAdmitted).toHaveBeenCalledWith('t', 0);
    expect(calls).toEqual(['invalidate:t', 'auth:t', 'suspend:t:TENANT_OFFLINE']);
  });

  it('drains only after every process acknowledges actual completion', async () => {
    const { calls, hooks } = setup();
    await hooks.closeRealtime('t');
    await hooks.stopQueue('t');
    await hooks.drainTransactions('t');
    // stopQueue closes again whatever was bound since the first close.
    expect(calls).toEqual([
      'suspend:t:TENANT_FROZEN',
      'suspend:t:TENANT_FROZEN',
      'claims:t',
      'drain:t@1000',
    ]);
  });

  it('fails the stage when a live resource cannot be closed, so Console retries the event', async () => {
    const { deps, hooks } = setup();
    deps.live.suspend.mockRejectedValueOnce(new Error('TENANT_LIVE_RESOURCE_CLOSE_FAILED: 1'));
    await expect(hooks.closeRealtime('t')).rejects.toThrow('CLOSE_FAILED');
    // The retried execution closes what is left.
    await expect(hooks.closeRealtime('t')).resolves.toBeUndefined();
    expect(deps.live.suspend).toHaveBeenCalledTimes(2);
  });

  it('checks acknowledgements even when draining is called first', async () => {
    const { calls, hooks } = setup();
    await hooks.drainTransactions('t');
    expect(calls).toEqual(['claims:t', 'drain:t@1000']);
  });

  it('closes nothing when the tenant is admitted again before the stage runs', async () => {
    const { deps, hooks } = setup(null);
    await hooks.closeRealtime('t');
    expect(deps.live.suspend).not.toHaveBeenCalled();
  });

  it('fails the stage when the drain times out, so Console retries the event', async () => {
    const { deps, hooks } = setup();
    deps.runtime.drainTransactions.mockRejectedValueOnce(new Error('lock timeout'));
    await expect(hooks.drainTransactions('t')).rejects.toThrow('lock timeout');
  });

  it('does not drain when a remote process has not stopped', async () => {
    const { deps, hooks } = setup();
    deps.waitForClaims.mockRejectedValueOnce(new Error('unconfirmed'));
    await expect(hooks.drainTransactions('t')).rejects.toThrow('unconfirmed');
    expect(deps.runtime.drainTransactions).not.toHaveBeenCalled();
  });

  it('reopens local live resources on activation', async () => {
    const { calls, hooks } = setup(null);
    await hooks.invalidateCaches('t');
    await hooks.resumeQueue('t');
    expect(calls).toEqual(['invalidate:t', 'auth:t', 'resume:t']);
  });
});
