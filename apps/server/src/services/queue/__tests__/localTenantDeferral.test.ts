// @vitest-environment node
import {
  currentTenantScope,
  runWithTenantScope,
  type TenantScope,
} from '@lobechat/database/tenant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TenantGateError } from '@/server/modules/Tenant/errors';

import { LocalQueueServiceImpl, TENANT_DEFERRED_STEP_RETRY_MS } from '../impls/local';

vi.mock('@/server/modules/Tenant/postgresClaims', () => ({
  heartbeatTenantProcess: vi.fn(),
  tenantClaims: { bind: () => async () => {}, enter: async () => async () => {} },
}));

const admission = vi.hoisted(() => ({ enterTenantId: vi.fn() }));
vi.mock('@/server/modules/Tenant/runtime', () => ({ getTenantRuntime: () => admission }));
// The global test setup replaces the gate with a pass-through; use the real one.
vi.mock('@/server/modules/Tenant/gate', async (importOriginal) => importOriginal());

const scopeOf = (credential: string) =>
  ({ session: { credential }, slug: 'acme', tenantId: 't-1' }) as unknown as TenantScope;
const message = { context: {}, delay: 10, operationId: 'op-1', stepIndex: 3 } as any;

describe('LocalQueueServiceImpl tenant admission', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    admission.enterTenantId.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const queue = new LocalQueueServiceImpl();
    const seenScopes: (TenantScope | undefined)[] = [];
    const executed = vi.fn(async () => {
      seenScopes.push(currentTenantScope());
    });
    queue.setExecutionCallback(executed);
    return { executed, queue, seenScopes };
  };

  it('does not start a step of a frozen tenant and runs it in a newly admitted scope once back', async () => {
    const { executed, queue, seenScopes } = setup();
    admission.enterTenantId.mockRejectedValue(new TenantGateError('TENANT_FROZEN'));
    await runWithTenantScope(scopeOf('before-rotation'), () => queue.scheduleMessage(message));

    await vi.advanceTimersByTimeAsync(10);
    expect(executed).not.toHaveBeenCalled();
    expect(admission.enterTenantId).toHaveBeenCalledWith('t-1');

    // Still frozen at the next attempt: still not started.
    await vi.advanceTimersByTimeAsync(TENANT_DEFERRED_STEP_RETRY_MS);
    expect(executed).not.toHaveBeenCalled();

    // Credentials were rotated while frozen: the step must use the new scope.
    admission.enterTenantId.mockResolvedValue({
      release: async () => {},
      scope: scopeOf('after-rotation'),
    });
    await vi.advanceTimersByTimeAsync(TENANT_DEFERRED_STEP_RETRY_MS);
    expect(executed).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith('op-1', 3, {}, undefined);
    expect(seenScopes[0]?.session).toEqual({ credential: 'after-rotation' });
  });

  it('drops a step of an offline tenant', async () => {
    const { executed, queue } = setup();
    admission.enterTenantId.mockRejectedValue(new TenantGateError('TENANT_OFFLINE'));
    await runWithTenantScope(scopeOf('c'), () => queue.scheduleMessage(message));

    await vi.advanceTimersByTimeAsync(10 + TENANT_DEFERRED_STEP_RETRY_MS * 3);
    expect(executed).not.toHaveBeenCalled();
    expect(admission.enterTenantId).toHaveBeenCalledTimes(1);
  });

  it('runs an admitted tenant step right away in the scope admitted for it', async () => {
    const { executed, queue, seenScopes } = setup();
    const admitted = scopeOf('current');
    admission.enterTenantId.mockResolvedValue({ release: async () => {}, scope: admitted });
    await runWithTenantScope(scopeOf('scheduled'), () => queue.scheduleMessage(message));
    await vi.advanceTimersByTimeAsync(10);
    expect(executed).toHaveBeenCalledTimes(1);
    expect(seenScopes[0]).toBe(admitted);
  });

  it('keeps running steps scheduled outside any tenant', async () => {
    const { executed, queue } = setup();
    await queue.scheduleMessage(message);
    await vi.advanceTimersByTimeAsync(10);
    expect(executed).toHaveBeenCalledTimes(1);
    expect(admission.enterTenantId).not.toHaveBeenCalled();
  });
});
