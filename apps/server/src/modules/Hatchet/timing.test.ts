// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { AGENT_RUNTIME_STATE_TTL_SECONDS } from '@/server/modules/AgentRuntime/AgentStateManager';

import { HATCHET_TIMING } from './config';

/**
 * The step timeouts, the Redis state TTL and the lock-conflict wait are kept in
 * different modules but describe one timeline; these pin how they must relate.
 */
describe('Hatchet step timing contract', () => {
  it('keeps one HTTP attempt inside the task execution timeout', () => {
    expect(HATCHET_TIMING.stepHttpTimeoutMs).toBeLessThan(HATCHET_TIMING.stepExecutionTimeoutMs);
  });

  it('keeps the longest wait between two attempts inside the runtime state TTL', () => {
    const longestGapMs =
      HATCHET_TIMING.queueTimeoutMs +
      HATCHET_TIMING.stepExecutionTimeoutMs +
      HATCHET_TIMING.retryWaitCapMs;

    expect(longestGapMs).toBeLessThan(AGENT_RUNTIME_STATE_TTL_SECONDS * 1000);
  });

  it('lets a workflow delivery finish its budget and then the slowest single model call', () => {
    // Workflow/serve.ts hands over after 5 minutes of steps, but only at a step boundary; the
    // slowest single model call measured in production took 2,298s (see config.ts).
    const longestDeliveryMs = 5 * 60_000 + 2298_000;

    expect(HATCHET_TIMING.workflowDeliveryHttpTimeoutMs).toBeGreaterThan(longestDeliveryMs);
    expect(HATCHET_TIMING.workflowDeliveryHttpTimeoutMs).toBeLessThanOrEqual(
      HATCHET_TIMING.deliveryExecutionTimeoutMs - 60_000,
    );
  });
});
