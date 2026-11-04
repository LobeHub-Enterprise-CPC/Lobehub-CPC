// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appEnv: { enableQueueAgentRuntime: true },
}));

vi.mock('@/envs/app', () => ({ appEnv: mocks.appEnv }));
vi.mock('./deliver', () => ({ deliver: vi.fn() }));

const { getDirectDeliveryClient } = await import('./directDelivery');
const { HatchetPublisher } = await import('./publisher');
const { LocalPublisher } = await import('./localPublisher');

describe('getDirectDeliveryClient', () => {
  afterEach(() => {
    mocks.appEnv.enableQueueAgentRuntime = true;
  });

  it('shares one Hatchet publisher in queue mode', () => {
    const client = getDirectDeliveryClient();
    expect(client).toBeInstanceOf(HatchetPublisher);
    expect(getDirectDeliveryClient()).toBe(client);
  });

  it('delivers in-process in local mode', () => {
    mocks.appEnv.enableQueueAgentRuntime = false;
    const client = getDirectDeliveryClient();
    expect(client).toBeInstanceOf(LocalPublisher);
    expect(getDirectDeliveryClient()).toBe(client);
  });
});
