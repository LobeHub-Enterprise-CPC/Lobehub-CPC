// @vitest-environment node
import { IdempotencyCollisionError } from '@hatchet-dev/typescript-sdk/v1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HATCHET_TIMING } from '@/server/modules/Hatchet/config';
import { pendingPublishCount } from '@/server/modules/Hatchet/pending';
import type { DeliveryInput } from '@/server/modules/Hatchet/types';

import type { QueueMessage } from '../types';
import { HatchetQueueServiceImpl } from './hatchet';

const step = vi.hoisted(() => ({ runNoWait: vi.fn(), schedule: vi.fn() }));

vi.mock('@/server/modules/Hatchet/client', () => ({
  getHatchetClient: () => ({
    task: ({ name }: { name: string }) =>
      name === 'cpc-agent-step' ? step : { runNoWait: vi.fn(), schedule: vi.fn() },
  }),
}));
vi.mock('@/server/modules/Hatchet/deliver', () => ({ deliver: vi.fn() }));

const endpoint = 'https://app.example.com/orgs/acme/api/agent/run';

const message = (overrides: Partial<QueueMessage> = {}): QueueMessage => ({
  context: { phase: 'user_input' } as QueueMessage['context'],
  endpoint,
  execution: { sourceAcceptedVersion: 7, tenantId: 'tenant-a' },
  operationId: 'op-1',
  priority: 'normal',
  stepIndex: 4,
  ...overrides,
});

const runRef = (id: string) => ({ runId: Promise.resolve(id) });

type RunOptions = { additionalMetadata: Record<string, string>; priority: number };
const runs = () => step.runNoWait.mock.calls as [DeliveryInput, RunOptions][];
const schedules = () => step.schedule.mock.calls as [Date, DeliveryInput, RunOptions][];

describe('HatchetQueueServiceImpl', () => {
  let impl: HatchetQueueServiceImpl;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
    step.runNoWait.mockResolvedValue(runRef('run-1'));
    step.schedule.mockResolvedValue({ metadata: { id: 'sched-1' } });
    impl = new HatchetQueueServiceImpl();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('starts a sub-second delay at once and schedules a longer one at now + delay (ms)', async () => {
    await expect(impl.scheduleMessage(message())).resolves.toBe('run_run-1');
    await expect(impl.scheduleMessage(message({ delay: 999 }))).resolves.toBe('run_run-1');
    await expect(impl.scheduleMessage(message({ delay: 1500 }))).resolves.toBe('sched_sched-1');

    expect(runs()).toHaveLength(2);
    expect(schedules()).toHaveLength(1);
    expect(schedules()[0][0]).toEqual(new Date(Date.now() + 1500));
  });

  it('delivers the QStash step body and headers to the step endpoint', async () => {
    await impl.scheduleMessage(
      message({
        payload: { humanInput: 'yes' },
        priority: 'high',
        retries: 5,
        retryDelay: '1000 * (1 + retried)',
      }),
    );
    await impl.scheduleMessage(message());

    const [[resume], [plain]] = runs();
    expect(JSON.parse(resume.body)).toEqual({
      context: { phase: 'user_input' },
      execution: { sourceAcceptedVersion: 7, tenantId: 'tenant-a' },
      operationId: 'op-1',
      payload: { humanInput: 'yes' },
      priority: 'high',
      stepIndex: 4,
      timestamp: Date.now(),
    });
    expect(resume).toMatchObject({
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Operation-Id': 'op-1',
        'X-Agent-Priority': 'high',
        'X-Agent-Step-Index': '4',
      },
      retries: 5,
      retryDelay: '1000 * (1 + retried)',
      tenantKey: 'tenant-a',
      timeoutMs: HATCHET_TIMING.stepHttpTimeoutMs,
      url: endpoint,
    });
    // QStash's default budget.
    expect(plain.retries).toBe(3);
    expect(plain).not.toHaveProperty('retryDelay');
  });

  it('preserves each caller-built tenant callback URL in a batch', async () => {
    const endpoints = [
      'https://first.example.com/orgs/acme/api/agent/run?source=resume',
      'https://second.example.com/orgs/other-team/api/agent/run?source=step',
    ];

    await impl.scheduleBatchMessages(
      endpoints.map((url, index) =>
        message({ endpoint: url, operationId: `op-${index}`, stepIndex: index }),
      ),
    );

    expect(runs().map(([input]) => input.url)).toEqual(endpoints);
  });

  it('returns the run that already holds the deduplication key', async () => {
    step.runNoWait.mockRejectedValueOnce(new IdempotencyCollisionError('run-existing'));
    await expect(
      impl.scheduleMessage(message({ deduplicationId: 'agent-intervention:op-1:4' })),
    ).resolves.toBe('run_run-existing');

    step.runNoWait.mockRejectedValueOnce(new Error('engine unavailable'));
    await expect(impl.scheduleMessage(message())).rejects.toThrow('engine unavailable');
  });

  it('scopes deduplication keys to the tenant and keeps undeduplicated messages unique', async () => {
    const tenantB = { sourceAcceptedVersion: 1, tenantId: 'tenant-b' };
    await impl.scheduleMessage(message({ deduplicationId: 'step:op-1:4' }));
    await impl.scheduleMessage(message({ deduplicationId: 'step:op-1:4' }));
    await impl.scheduleMessage(message({ deduplicationId: 'step:op-1:4', execution: tenantB }));
    await impl.scheduleMessage(message());
    await impl.scheduleMessage(message());

    const keys = runs().map(([input]) => input.dedupKey);
    expect(keys[1]).toBe(keys[0]);
    expect(new Set(keys).size).toBe(4);
  });

  it('maps queue priority onto Hatchet priority', async () => {
    for (const priority of ['high', 'normal', 'low', undefined] as const)
      await impl.scheduleMessage(message({ priority }));

    expect(runs().map(([, options]) => options.priority)).toEqual([3, 2, 1, 2]);
  });

  it('labels runs and schedules with string metadata naming the delivery purpose', async () => {
    await impl.scheduleMessage(message());
    await impl.scheduleMessage(message({ payload: { humanInput: 'yes' } }));
    await impl.scheduleMessage(message({ delay: 5000, payload: { groupMemberTimeout: true } }));
    await impl.scheduleMessage(
      message({ kind: 'tenant-job', operationId: 'defer:message-1', stepIndex: 0 }),
    );

    const [[, plain], [, resume], [, job]] = runs();
    const [[, , watchdog]] = schedules();
    expect(plain.additionalMetadata).toEqual({
      kind: 'operation',
      operationId: 'op-1',
      purpose: 'step',
      stepIndex: '4',
      tenantId: 'tenant-a',
    });
    expect(resume.additionalMetadata).toMatchObject({ purpose: 'resume' });
    expect(watchdog.additionalMetadata).toMatchObject({ purpose: 'control', stepIndex: '4' });
    expect(job.additionalMetadata).toMatchObject({
      kind: 'tenant-job',
      operationId: 'defer:message-1',
      purpose: 'job',
      stepIndex: '0',
    });
    for (const options of [plain, resume, watchdog, job])
      for (const value of Object.values(options.additionalMetadata))
        expect(typeof value).toBe('string');
  });

  it('refuses a retry policy the delivery cannot honour before publishing anything', async () => {
    await expect(impl.scheduleMessage(message({ retries: 20 }))).rejects.toThrow(/retries/);
    await expect(impl.scheduleMessage(message({ retryDelay: 'pow(2, retried' }))).rejects.toThrow(
      /retryDelay/,
    );
    expect(step.runNoWait).not.toHaveBeenCalled();

    await expect(impl.scheduleMessage(message({ retries: 19 }))).resolves.toBe('run_run-1');
  });

  it('clamps an oversized body to the QStash budget instead of failing the publish', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runaway = 'x'.repeat(12 * 1024 * 1024);

    await impl.scheduleMessage(
      message({
        context: {
          payload: { toolsResult: [{ content: runaway }] },
          phase: 'llm_result',
        } as unknown as QueueMessage['context'],
      }),
    );

    const [[input]] = runs();
    expect(Buffer.byteLength(input.body)).toBeLessThan(9 * 1024 * 1024);
    expect(JSON.parse(input.body).context.payload.toolsResult[0].content).toContain(
      'characters omitted so the step could be scheduled',
    );
  });

  it('refuses an input past the gRPC budget with an error naming the operation', async () => {
    // Under the body quota, but every quote doubles again once the body is a string in the input.
    const quotes = '"'.repeat(4 * 1024 * 1024);

    const error = await impl
      .scheduleMessage(message({ payload: { quotes } }))
      .catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('op-1');
    expect(error.message).toMatch(/\d+ bytes/);
    expect(step.runNoWait).not.toHaveBeenCalled();
  });

  it('counts each publish as pending until Hatchet answers', async () => {
    let acceptRun!: (ref: unknown) => void;
    step.runNoWait.mockReturnValueOnce(new Promise((resolve) => (acceptRun = resolve)));
    let acceptSchedule!: (scheduled: unknown) => void;
    step.schedule.mockReturnValueOnce(new Promise((resolve) => (acceptSchedule = resolve)));

    const run = impl.scheduleMessage(message());
    const scheduled = impl.scheduleMessage(message({ delay: 60_000 }));
    expect(pendingPublishCount()).toBe(2);

    acceptRun(runRef('run-9'));
    await expect(run).resolves.toBe('run_run-9');
    expect(pendingPublishCount()).toBe(1);
    acceptSchedule({ metadata: { id: 'sched-9' } });
    await expect(scheduled).resolves.toBe('sched_sched-9');
    expect(pendingPublishCount()).toBe(0);
  });
});
