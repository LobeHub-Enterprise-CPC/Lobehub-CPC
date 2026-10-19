// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  publishJSON: vi.fn(async () => ({ messageId: 'm1' })),
  runWidgetSchedulerTick: vi.fn(),
}));

vi.mock('@/database/server', () => ({ getServerDB: vi.fn().mockResolvedValue({}) }));
vi.mock('@/envs/app', () => ({ appEnv: { enableQueueAgentRuntime: true } }));
vi.mock('@/libs/qstash', () => ({ qstashClient: { publishJSON: mocks.publishJSON } }));
vi.mock('@/server/modules/Tenant/callbackUrl');
vi.mock('@/server/services/widget/sandbox', () => ({ createWidgetSandboxRunner: vi.fn() }));
vi.mock('@/server/services/widget/scheduler', () => ({
  isWidgetResumeTarget: (target: { runId?: string }) => Boolean(target.runId),
  runWidgetSchedulerTick: mocks.runWidgetSchedulerTick,
}));

const { tick } = await import('../tick');

describe('widget scheduler tick in queue mode', () => {
  it('dispatches each due widget to run-widget of the ticking tenant', async () => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
    mocks.runWidgetSchedulerTick.mockImplementation(async (_db, _deps, { dispatch }) => {
      await dispatch({ slot: new Date('2026-10-19T00:00:00Z'), widgetId: 'w1' });
      await dispatch({
        leaseStartedAt: new Date('2026-10-19T00:00:00Z'),
        runId: 'r1',
        widgetId: 'w2',
      });
      return { due: 2 };
    });

    const json = vi.fn((body) => body);
    await tick({ json, req: { json: async () => ({}) } } as any);

    expect(mocks.publishJSON.mock.calls.map(([request]: any[]) => request.url)).toEqual([
      'https://app.example.com/t/acme/api/workflows/widget/run-widget',
      'https://app.example.com/t/acme/api/workflows/widget/run-widget',
    ]);
    vi.unstubAllEnvs();
  });
});
