// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  forEachTenant: vi.fn(async (_job: string, operation: (tenantId: string) => Promise<string>) => ({
    failed: [],
    succeeded: [{ result: await operation('tenant-a'), tenantId: 'tenant-a' }],
  })),
  publishJSON: vi.fn(async () => ({ messageId: 'm1' })),
}));

vi.mock('@/libs/qstash', () => ({ qstashClient: { publishJSON: mocks.publishJSON } }));
vi.mock('@/server/modules/Tenant/callbackUrl');
vi.mock('@/server/modules/Tenant/fanOut', () => ({ forEachTenant: mocks.forEachTenant }));
vi.mock('@/server/services/gateway/tenantStart', () => ({ startGatewayForAllTenants: vi.fn() }));
vi.mock('../../agent/middlewares/qstashAuth', () => ({
  qstashAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { default: app } = await import('../index');

describe('deployment-wide schedule fan-out', () => {
  it.each([
    ['goal-sweep', '/t/acme/api/workflows/goal/sweep'],
    ['task-schedule-dispatch', '/t/acme/api/workflows/task/schedule-dispatch'],
    ['widget-tick', '/t/acme/api/workflows/widget/tick'],
  ])('publishes %s once per tenant to the tenant address', async (job, path) => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
    mocks.publishJSON.mockClear();

    const response = await app.request(`/api/cron/${job}`, { body: '{}', method: 'POST' });

    expect(response.status).toBe(200);
    expect(mocks.publishJSON).toHaveBeenCalledWith(
      expect.objectContaining({ url: `https://app.example.com${path}` }),
    );
    vi.unstubAllEnvs();
  });

  it('rejects an unknown schedule', async () => {
    const response = await app.request('/api/cron/unknown', { body: '{}', method: 'POST' });
    expect(response.status).toBe(404);
  });
});
