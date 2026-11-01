// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const hatchet = vi.hoisted(() => ({ enabled: false }));

vi.mock('@/server/modules/Hatchet/config', () => ({
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
    const { STEP_LOCK_RETRY_MAX_ATTEMPTS, stepLockRetryDelayMs } = await load();

    expect(STEP_LOCK_RETRY_MAX_ATTEMPTS).toBe(12);
    expect(sequence(stepLockRetryDelayMs, 6)).toEqual([15, 30, 60, 120, 120, 120]);
  });

  it('retries after 1s first with Hatchet delivery, then follows the same schedule', async () => {
    hatchet.enabled = true;
    const { STEP_LOCK_RETRY_MAX_ATTEMPTS, stepLockRetryDelayMs } = await load();

    expect(STEP_LOCK_RETRY_MAX_ATTEMPTS).toBe(13);
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
});
