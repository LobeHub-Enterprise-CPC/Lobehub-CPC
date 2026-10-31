// @vitest-environment node
import type { TenantScope } from '@lobechat/database/tenant';
import { runWithTenantScope } from '@lobechat/database/tenant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HATCHET_TIMING } from './config';
import { pendingPublishCount } from './pending';
import { HatchetPublisher } from './publisher';
import type { DeliveryInput } from './types';

const hatchet = vi.hoisted(() => ({
  cancelRuns: vi.fn(),
  deleteSchedule: vi.fn(),
  runNoWait: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('./client', () => ({
  getHatchetClient: () => ({
    runs: { cancel: hatchet.cancelRuns },
    schedules: { delete: hatchet.deleteSchedule },
    // Record which task each trigger went to.
    task: ({ name }: { name: string }) => ({
      runNoWait: (...args: unknown[]) => hatchet.runNoWait(name, ...args),
      schedule: (...args: unknown[]) => hatchet.schedule(name, ...args),
    }),
  }),
}));
vi.mock('./deliver', () => ({ deliver: vi.fn() }));

const url = 'https://app.example.com/orgs/acme/api/workflows/goal/advance';
const external = 'https://hooks.example.com/notify';

const tenant = (tenantId: string, slug = 'acme') =>
  ({ acceptedVersion: 1, slug, tenantId }) as unknown as TenantScope;

type RunOptions = { additionalMetadata: Record<string, string> };
const runs = () => hatchet.runNoWait.mock.calls as [string, DeliveryInput, RunOptions][];
const lastRun = () => runs().at(-1)!;
const lastScheduleAt = () => (hatchet.schedule.mock.calls.at(-1) as [string, Date])[1];

describe('HatchetPublisher', () => {
  let publisher: HatchetPublisher;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
    hatchet.runNoWait.mockResolvedValue({ runId: Promise.resolve('run-1') });
    hatchet.schedule.mockResolvedValue({ metadata: { id: 'sched-1' } });
    publisher = new HatchetPublisher();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('publishes at once unless delayed, reading delay as QStash seconds or durations', async () => {
    await expect(publisher.publishJSON({ body: {}, url })).resolves.toEqual({
      messageId: 'run_run-1',
    });
    await expect(publisher.publishJSON({ body: {}, delay: 0, url })).resolves.toEqual({
      messageId: 'run_run-1',
    });

    for (const [delay, ms] of [
      [30, 30_000],
      ['45s', 45_000],
      ['2m', 120_000],
      ['3h', 10_800_000],
      ['1d', 86_400_000],
    ] as const) {
      await expect(publisher.publishJSON({ body: {}, delay, url })).resolves.toEqual({
        messageId: 'sched_sched-1',
      });
      expect(lastScheduleAt()).toEqual(new Date(Date.now() + ms));
    }
    expect(runs()).toHaveLength(2);
  });

  it('prefers notBefore over delay and publishes a past notBefore at once', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);

    await publisher.publishJSON({ body: {}, delay: 30, notBefore: nowSeconds + 600, url });
    expect(lastScheduleAt()).toEqual(new Date((nowSeconds + 600) * 1000));

    await publisher.publishJSON({ body: {}, delay: 30, notBefore: nowSeconds - 5, url });
    expect(runs()).toHaveLength(1);
  });

  it('turns a publish into a cpc-delivery input', async () => {
    await runWithTenantScope(tenant('tenant-1'), () =>
      publisher.publishJSON({
        body: { goalId: 'goal-1' },
        deduplicationId: 'goal-advance:goal-1',
        headers: { 'Authorization': 'Bearer token', 'Content-Type': 'text/plain' },
        retries: 8,
        retryDelay: '60000',
        timeout: 45,
        url,
      }),
    );

    const [task, input, options] = lastRun();
    expect(task).toBe('cpc-delivery');
    expect(input).toMatchObject({
      body: '{"goalId":"goal-1"}',
      retries: 8,
      retryDelay: '60000',
      tenantKey: 'acme',
      timeoutMs: 45_000,
      url,
    });
    // publishJSON semantics: business headers forwarded, the body always sent as JSON.
    const headers = new Headers(input.headers);
    expect(headers.get('authorization')).toBe('Bearer token');
    expect(headers.get('content-type')).toBe('application/json');
    expect(options.additionalMetadata).toEqual({ kind: 'delivery', tenantId: 'acme' });
  });

  it('falls back to QStash defaults and serializes any body as JSON, as publishJSON does', async () => {
    await publisher.publishJSON({ body: 'hello', url });
    await publisher.publishJSON({ timeout: '2m', url });

    const [[, string], [, empty]] = runs();
    expect(string).toMatchObject({
      body: '"hello"',
      retries: 3,
      timeoutMs: HATCHET_TIMING.deliveryHttpTimeoutMs,
    });
    expect(string).not.toHaveProperty('retryDelay');
    expect(empty).toMatchObject({ body: '', timeoutMs: 120_000 });
  });

  it('refuses a timeout the delivery task could not wait out', async () => {
    const limitSeconds = (HATCHET_TIMING.deliveryExecutionTimeoutMs - 60_000) / 1000;

    await publisher.publishJSON({ body: {}, timeout: limitSeconds, url });
    await publisher.publishJSON({ body: {}, timeout: `${limitSeconds / 60}m` as const, url });
    await expect(
      publisher.publishJSON({ body: {}, timeout: limitSeconds + 1, url }),
    ).rejects.toThrow(/timeout/);
    await expect(
      publisher.publishJSON({
        body: {},
        timeout: `${HATCHET_TIMING.deliveryExecutionTimeoutMs / 60_000}m` as const,
        url,
      }),
    ).rejects.toThrow(/timeout/);
    await expect(publisher.publishJSON({ body: {}, timeout: 0, url })).rejects.toThrow(/timeout/);
    expect(runs()).toHaveLength(2);
  });

  it.each<[string, Record<string, unknown>]>([
    ['callback', { callback: 'https://app.example.com/callback' }],
    ['failureCallback', { failureCallback: 'https://app.example.com/failed' }],
    ['flowControl', { flowControl: { key: 'k', parallelism: 1 } }],
    ['queueName', { queueName: 'agent' }],
    ['topic', { topic: 'events' }],
    ['label', { label: 'goal' }],
    ['method', { method: 'PUT' }],
    ['contentBasedDeduplication', { contentBasedDeduplication: true }],
    ['retries above the per-message cap', { retries: 20 }],
    ['fractional retries', { retries: 1.5 }],
    ['an invalid retryDelay', { retryDelay: 'pow(2, retried' }],
    ['a relative url', { url: '/api/workflows/goal/advance' }],
    ['a non-http url', { url: 'ftp://app.example.com/file' }],
    ['an unknown delay unit', { delay: '5w' }],
    ['a negative delay', { delay: -1 }],
    ['an Upstash control header', { headers: { 'Upstash-Delay': '10s' } }],
  ])('rejects %s instead of silently dropping it', async (_, override) => {
    await expect(
      publisher.publishJSON({ body: {}, url, ...override } as Parameters<
        HatchetPublisher['publishJSON']
      >[0]),
    ).rejects.toThrow();
    expect(hatchet.runNoWait).not.toHaveBeenCalled();
    expect(hatchet.schedule).not.toHaveBeenCalled();
  });

  it('keys the tenant by URL prefix, then by request tenant, else a shared key', async () => {
    await publisher.publishJSON({ url });
    await runWithTenantScope(tenant('tenant-1', 'other'), () => publisher.publishJSON({ url }));
    await runWithTenantScope(tenant('tenant-1'), () => publisher.publishJSON({ url: external }));
    await publisher.publishJSON({ url: external });

    expect(runs().map(([, input]) => input.tenantKey)).toEqual(['acme', 'acme', 'tenant-1', '_']);
  });

  it('scopes deduplication to the tenant', async () => {
    const other = 'https://app.example.com/orgs/beta/api/workflows/goal/advance';
    await publisher.publishJSON({ deduplicationId: 'widget:w-1:slot', url });
    await publisher.publishJSON({ deduplicationId: 'widget:w-1:slot', url });
    await publisher.publishJSON({ deduplicationId: 'widget:w-1:slot', url: other });
    await publisher.publishJSON({ url });

    const keys = runs().map(([, input]) => input.dedupKey);
    expect(keys[1]).toBe(keys[0]);
    expect(new Set(keys).size).toBe(3);
  });

  it('counts a publish as pending until Hatchet answers', async () => {
    let accept!: (ref: unknown) => void;
    hatchet.runNoWait.mockReturnValueOnce(new Promise((resolve) => (accept = resolve)));

    const published = publisher.publishJSON({ url });
    expect(pendingPublishCount()).toBe(1);

    accept({ runId: Promise.resolve('run-7') });
    await expect(published).resolves.toEqual({ messageId: 'run_run-7' });
    expect(pendingPublishCount()).toBe(0);
  });

  describe('messages.delete', () => {
    const notFound = Object.assign(new Error('Request failed with status code 404'), {
      isAxiosError: true,
      response: { status: 404 },
    });

    it('deletes schedules and cancels runs by id prefix, ignoring foreign ids', async () => {
      await publisher.messages.delete('sched_s-1');
      await publisher.messages.delete('run_r-1');
      // A QStash message id from before the switch: nothing of ours to cancel.
      await publisher.messages.delete('msg_2KxeoA');

      expect(hatchet.deleteSchedule.mock.calls).toEqual([['s-1']]);
      expect(hatchet.cancelRuns.mock.calls).toEqual([[{ ids: ['r-1'] }]]);
    });

    it('treats a target that no longer exists as cancelled', async () => {
      hatchet.deleteSchedule.mockRejectedValueOnce(notFound);
      hatchet.cancelRuns.mockRejectedValueOnce(notFound);

      await expect(publisher.messages.delete('sched_gone')).resolves.toBeUndefined();
      await expect(publisher.messages.delete('run_gone')).resolves.toBeUndefined();

      hatchet.cancelRuns.mockRejectedValueOnce(new Error('engine unavailable'));
      await expect(publisher.messages.delete('run_r-2')).rejects.toThrow('engine unavailable');
    });
  });
});
