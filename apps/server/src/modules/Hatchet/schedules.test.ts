// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  forEachTenant: vi.fn(),
  publishJSON: vi.fn(async () => ({ messageId: 'm1' })),
  task: vi.fn((options: object) => options),
}));

vi.mock('@/server/modules/Tenant/callbackUrl');
vi.mock('@/server/modules/Tenant/fanOut', () => ({ forEachTenant: mocks.forEachTenant }));
vi.mock('./directDelivery', () => ({
  getDirectDeliveryClient: () => ({ publishJSON: mocks.publishJSON }),
}));
vi.mock('./client', () => ({ getHatchetClient: () => ({ task: mocks.task }) }));

const { fanOutTenantSchedule, getScheduleTasks } = await import('./schedules');

const tenants = (...ids: string[]) =>
  mocks.forEachTenant.mockImplementation(
    async (_job: string, operation: (tenantId: string) => Promise<string>) => {
      const succeeded = [];
      const failed = [];
      for (const tenantId of ids) {
        try {
          succeeded.push({ result: await operation(tenantId), tenantId });
        } catch {
          failed.push({ reason: 'Error', tenantId });
        }
      }
      return { failed, succeeded };
    },
  );

describe('tenant schedules', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.publishJSON.mockClear();
  });

  it.each([
    ['goal-sweep', '/orgs/acme/api/workflows/goal/sweep'],
    ['task-schedule-dispatch', '/orgs/acme/api/workflows/task/schedule-dispatch'],
    ['widget-tick', '/orgs/acme/api/workflows/widget/tick'],
  ] as const)('publishes %s once per tenant to the tenant address', async (job, path) => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
    tenants('acme');

    expect(await fanOutTenantSchedule(job)).toEqual({ failed: 0, published: 1 });
    expect(mocks.publishJSON).toHaveBeenCalledWith({
      body: {},
      url: `https://app.example.com${path}`,
    });
  });

  it('sends the deliveries to the internal address when there is one', async () => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('INTERNAL_APP_URL', 'http://cpc:3210');
    tenants('acme');

    await fanOutTenantSchedule('goal-sweep');
    expect(mocks.publishJSON).toHaveBeenCalledWith({
      body: {},
      url: 'http://cpc:3210/orgs/acme/api/workflows/goal/sweep',
    });
  });

  it('declares one cron task per job, failing a tick only when no tenant got its delivery', async () => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
    const tasks = getScheduleTasks() as unknown as {
      fn: () => Promise<unknown>;
      name: string;
      onCrons: string[];
    }[];
    expect(tasks.map(({ name, onCrons }) => [name, onCrons])).toEqual([
      ['cpc-cron-goal-sweep', ['*/5 * * * *']],
      ['cpc-cron-task-schedule-dispatch', ['*/10 * * * *']],
      ['cpc-cron-widget-tick', ['* * * * *']],
    ]);

    mocks.publishJSON.mockRejectedValueOnce(new Error('down'));
    tenants('acme', 'beta');
    await expect(tasks[0].fn()).resolves.toEqual({ failed: 1, published: 1 });

    mocks.publishJSON.mockRejectedValue(new Error('down'));
    await expect(tasks[0].fn()).rejects.toThrow('publishing failed for all 2 tenant(s)');
    mocks.publishJSON.mockReset();
    mocks.publishJSON.mockResolvedValue({ messageId: 'm1' });
  });
});
