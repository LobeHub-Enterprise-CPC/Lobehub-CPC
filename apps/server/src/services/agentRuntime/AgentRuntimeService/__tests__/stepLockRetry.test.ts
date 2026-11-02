// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as HatchetConfig from '@/server/modules/Hatchet/config';

const hatchet = vi.hoisted(() => ({ enabled: false }));

vi.mock('@/server/modules/Hatchet/config', async (importOriginal) => ({
  ...(await importOriginal<typeof HatchetConfig>()),
  isHatchetDeliveryEnabled: () => hatchet.enabled,
}));

const load = async () => {
  vi.resetModules();
  const [constants, utils] = await Promise.all([import('../constants'), import('../utils')]);
  return { ...constants, ...utils };
};

const sequence = (delay: (attempt: number) => number, attempts: number) =>
  Array.from({ length: attempts }, (_, i) => delay(i + 1) / 1000);

describe('step lock retry backoff', () => {
  afterEach(() => {
    hatchet.enabled = false;
  });

  it('keeps the existing schedule without Hatchet delivery', async () => {
    const { stepLockRetryDelayMs } = await load();

    expect(sequence(stepLockRetryDelayMs, 6)).toEqual([15, 30, 60, 120, 120, 120]);
  });

  it('retries after 1s first with Hatchet delivery, then follows the same schedule', async () => {
    hatchet.enabled = true;
    const { stepLockRetryDelayMs } = await load();

    expect(sequence(stepLockRetryDelayMs, 7)).toEqual([1, 15, 30, 60, 120, 120, 120]);
  });

  it('spans the same total wait after the extra first retry', async () => {
    const before = await load();
    const legacy = sequence(before.stepLockRetryDelayMs, before.STEP_LOCK_RETRY_MAX_ATTEMPTS);
    hatchet.enabled = true;
    const after = await load();
    const withHatchet = sequence(after.stepLockRetryDelayMs, after.STEP_LOCK_RETRY_MAX_ATTEMPTS);

    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    expect(sum(withHatchet)).toBe(sum(legacy) + 1);
  });

  it('keeps waiting behind a holder for as long as Hatchet lets one step attempt run', async () => {
    hatchet.enabled = true;
    const { HATCHET_TIMING } = await import('@/server/modules/Hatchet/config');
    const { STEP_LOCK_RETRY_MAX_ATTEMPTS, stepLockRetryDelayMs } = await load();
    const totalWaitMs = sequence(stepLockRetryDelayMs, STEP_LOCK_RETRY_MAX_ATTEMPTS).reduce(
      (total, seconds) => total + seconds * 1000,
      0,
    );

    expect(totalWaitMs).toBeGreaterThanOrEqual(HATCHET_TIMING.stepExecutionTimeoutMs);
  });
});
