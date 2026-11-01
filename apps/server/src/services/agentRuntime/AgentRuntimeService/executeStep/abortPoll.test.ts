// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TenantGateError } from '@/server/modules/Tenant/errors';
import { assertGatewayVersion } from '@/server/services/gatewayAuthorization';
import { GatewayAuthorizationError } from '@/server/services/gatewayAuthorization/wire';

import { STEP_ABORT_POLL_INTERVAL_MS } from '../constants';
import { startStepAbortPoll, type StepAbortPoll, type StepAbortPollDeps } from './abortPoll';

vi.mock('@/server/services/gatewayAuthorization/index', () => ({ assertGatewayVersion: vi.fn() }));
vi.mock('@/server/modules/Tenant/liveResources', () => ({
  getTenantLiveResources: () => ({ bind: () => () => {} }),
}));
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: async () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ metadata: { tenantId: 't-1', sourceAcceptedVersion: 1 } }],
        }),
      }),
    }),
  }),
}));

const scope = { tenantId: 't-1', acceptedVersion: 1 } as TenantScope;
// Fake timer callbacks need the same trusted scope as the real async timer.
const advance = (ms: number) => runWithTenantScope(scope, () => vi.advanceTimersByTimeAsync(ms));

describe('running step authorization polling', () => {
  let poll: StepAbortPoll;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(assertGatewayVersion).mockReset();
  });
  afterEach(() => {
    poll?.stop();
    vi.useRealTimers();
  });

  const setup = () => {
    const coordinator = {
      isInterrupted: vi.fn(async () => false),
      loadAgentState: vi.fn(),
      markInterrupted: vi.fn(),
    };
    poll = runWithTenantScope(scope, () =>
      startStepAbortPoll({ coordinator } as unknown as StepAbortPollDeps, 'op-1', 1, {
        tenantId: 't-1',
        sourceAcceptedVersion: 1,
      }),
    );
    return coordinator;
  };

  it.each([new Error('platform read failed'), new TenantGateError('TENANT_UNAVAILABLE')])(
    'backs off infrastructure failures without writing an interrupt: %s',
    async (error) => {
      vi.mocked(assertGatewayVersion).mockRejectedValueOnce(error);
      const coordinator = setup();
      await advance(STEP_ABORT_POLL_INTERVAL_MS);
      expect(poll.signal.aborted).toBe(false);
      expect(coordinator.markInterrupted).not.toHaveBeenCalled();
      await advance(STEP_ABORT_POLL_INTERVAL_MS * 2 - 1);
      expect(coordinator.isInterrupted).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(coordinator.isInterrupted).toHaveBeenCalledTimes(2);
      // Success clears the existing backoff.
      await advance(STEP_ABORT_POLL_INTERVAL_MS);
      expect(coordinator.isInterrupted).toHaveBeenCalledTimes(3);
      expect(coordinator.markInterrupted).not.toHaveBeenCalled();
      expect(poll.signal.aborted).toBe(false);
    },
  );

  it.each([
    new GatewayAuthorizationError('TENANT_EXECUTION_VERSION_STALE', 409),
    new TenantGateError('TENANT_FROZEN'),
    new Error('query failed', { cause: new TenantGateError('TENANT_EXPIRED') }),
  ])('interrupts on an explicit authorization refusal: %s', async (error) => {
    vi.mocked(assertGatewayVersion).mockRejectedValueOnce(error);
    const coordinator = setup();
    await advance(STEP_ABORT_POLL_INTERVAL_MS);
    expect(coordinator.markInterrupted).toHaveBeenCalledExactlyOnceWith('op-1');
    expect(poll.signal.aborted).toBe(true);
  });

  it('honors a user Stop even when the platform check would fail', async () => {
    vi.mocked(assertGatewayVersion).mockRejectedValue(new Error('platform down'));
    const coordinator = setup();
    coordinator.isInterrupted.mockResolvedValue(true);
    await advance(STEP_ABORT_POLL_INTERVAL_MS);
    expect(poll.signal.aborted).toBe(true);
    expect(assertGatewayVersion).not.toHaveBeenCalled();
  });
});
