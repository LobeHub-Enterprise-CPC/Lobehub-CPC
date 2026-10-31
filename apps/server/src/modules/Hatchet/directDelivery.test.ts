// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appEnv: { enableHatchetAgentDelivery: false, enableQueueAgentRuntime: true },
  qstashClient: { messages: { delete: vi.fn() }, publishJSON: vi.fn() },
}));

vi.mock('@/envs/app', () => ({ appEnv: mocks.appEnv }));
vi.mock('@/libs/qstash', () => ({ qstashClient: mocks.qstashClient }));
vi.mock('./deliver', () => ({ deliver: vi.fn() }));

const { getDirectDeliveryClient } = await import('./directDelivery');
const { HatchetPublisher } = await import('./publisher');

describe('getDirectDeliveryClient', () => {
  afterEach(() => {
    mocks.appEnv.enableHatchetAgentDelivery = false;
    mocks.appEnv.enableQueueAgentRuntime = true;
  });

  it('keeps the QStash client unless queue mode delivers through Hatchet', () => {
    expect(getDirectDeliveryClient()).toBe(mocks.qstashClient);

    mocks.appEnv.enableHatchetAgentDelivery = true;
    mocks.appEnv.enableQueueAgentRuntime = false;
    expect(getDirectDeliveryClient()).toBe(mocks.qstashClient);
  });

  it('shares one Hatchet publisher in Hatchet delivery mode', () => {
    mocks.appEnv.enableHatchetAgentDelivery = true;

    const client = getDirectDeliveryClient();
    expect(client).toBeInstanceOf(HatchetPublisher);
    expect(getDirectDeliveryClient()).toBe(client);
  });
});
