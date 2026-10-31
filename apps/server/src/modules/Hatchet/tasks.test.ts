// @vitest-environment node
import { NonRetryableError, RetryAfterError } from '@hatchet-dev/typescript-sdk/v1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HATCHET_TIMING } from './config';
import type { DeliveryInput } from './types';

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  getHatchetClient: vi.fn(),
  task: vi.fn((options: { name: string }) => ({ name: options.name })),
}));

vi.mock('./client', () => ({ getHatchetClient: mocks.getHatchetClient }));
vi.mock('./deliver', () => ({ deliver: mocks.deliver }));

const input: DeliveryInput = {
  body: '{"stepIndex":1}',
  dedupKey: 'dedup-1',
  headers: { 'Content-Type': 'application/json' },
  retries: 3,
  tenantKey: 'tenant-a',
  timeoutMs: 1000,
  url: 'https://app.example.com/orgs/acme/api/agent/run',
};

/** Each test gets fresh task caches. */
const loadTasks = async () => {
  vi.resetModules();
  return import('./tasks');
};

const declared = () => mocks.task.mock.calls.map(([options]) => options as Record<string, any>);

describe('Hatchet delivery tasks', () => {
  beforeEach(() => {
    mocks.getHatchetClient.mockReturnValue({ task: mocks.task });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('declares nothing on import and each task once, on first use', async () => {
    const tasks = await loadTasks();
    expect(mocks.getHatchetClient).not.toHaveBeenCalled();

    const step = tasks.getAgentStepTask();
    const delivery = tasks.getDeliveryTask();

    expect(tasks.getAgentStepTask()).toBe(step);
    expect(tasks.getDeliveryTask()).toBe(delivery);
    expect(declared().map((options) => options.name)).toEqual(['cpc-agent-step', 'cpc-delivery']);
  });

  it('gives each task its own timeout and deduplicates by the input key', async () => {
    const tasks = await loadTasks();
    tasks.getAgentStepTask();
    tasks.getDeliveryTask();

    const [step, delivery] = declared();
    expect(step).toMatchObject({
      executionTimeout: HATCHET_TIMING.stepExecutionTimeoutMs,
      retries: 20,
      scheduleTimeout: HATCHET_TIMING.queueTimeoutMs,
    });
    expect(delivery).toMatchObject({
      executionTimeout: HATCHET_TIMING.deliveryExecutionTimeoutMs,
      retries: 20,
      scheduleTimeout: HATCHET_TIMING.deliveryQueueTimeoutMs,
    });

    for (const options of [step, delivery]) {
      expect(options.idempotency).toEqual({
        expression: 'input.dedupKey',
        strategy: 'ttl',
        ttlMs: HATCHET_TIMING.dedupTtlMs,
      });
    }
  });

  it.each(['getAgentStepTask', 'getDeliveryTask'] as const)(
    '%s turns each delivery outcome into the run result',
    async (getTask) => {
      const tasks = await loadTasks();
      tasks[getTask]();
      const [{ fn }] = declared();
      const ctx = { retryCount: () => 2, taskRunExternalId: () => 'task-run-1' };

      mocks.deliver.mockResolvedValueOnce({ kind: 'delivered', status: 204 });
      await expect(fn(input, ctx)).resolves.toEqual({ status: 204 });
      expect(mocks.deliver).toHaveBeenCalledWith(input, { attempt: 2, messageId: 'task-run-1' });

      mocks.deliver.mockResolvedValueOnce({
        afterMs: 12_000,
        kind: 'retry',
        reason: 'HTTP 503',
        status: 503,
      });
      const retry = await fn(input, ctx).catch((error: unknown) => error);
      expect(retry).toBeInstanceOf(RetryAfterError);
      expect(retry).toMatchObject({ afterMs: 12_000, message: 'HTTP 503' });

      mocks.deliver.mockResolvedValueOnce({ kind: 'failed', reason: 'HTTP 400', status: 400 });
      const failed = await fn(input, ctx).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(NonRetryableError);
      expect(failed).toMatchObject({ message: 'HTTP 400' });
    },
  );
});
