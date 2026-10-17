// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  publishOnboardingGenerationProgress,
  subscribeToOnboardingGenerationProgress,
} from '../index';

const { published, subscribed } = vi.hoisted(() => ({
  published: [] as string[],
  subscribed: [] as string[],
}));

vi.mock('ioredis', () => ({
  default: class {
    connect = vi.fn(async () => undefined);
    on = vi.fn();
    publish = vi.fn(async (channel: string) => void published.push(channel));
    quit = vi.fn(async () => undefined);
    removeListener = vi.fn();
    subscribe = vi.fn(async (channel: string) => void subscribed.push(channel));
    unsubscribe = vi.fn(async () => undefined);
  },
}));
vi.mock('@/envs/redis', () => ({
  getRedisConfig: () => ({ enabled: true, prefix: 'lobe', tls: false, url: 'redis://x' }),
}));
vi.mock('@/server/modules/Redis', () => ({ isRedisEnabled: () => true }));
vi.mock('@/database/server', () => ({ getServerDB: vi.fn(async () => ({})) }));
vi.mock('@/server/services/understanding/service', () => ({
  createUnderstandingService: async () => ({
    get: async () => ({ id: 'u1', sources: {}, writing: undefined }),
  }),
}));
vi.mock('@/server/services/taskRecommendation/service', () => ({
  TaskRecommendationNotFoundError: class extends Error {},
  createTaskRecommendationService: async () => ({ get: async () => undefined }),
}));

const inTenant = <T>(tenantId: string, fn: () => T) =>
  runWithTenantScope({ session: {}, slug: tenantId, tenantId } as unknown as TenantScope, fn);

describe('onboarding progress channel', () => {
  beforeEach(() => {
    published.length = 0;
    subscribed.length = 0;
  });

  it('keeps the same topic id of two tenants on separate channels', async () => {
    await inTenant('tenant-a', () => publishOnboardingGenerationProgress('user-1', 'topic-1'));
    await inTenant('tenant-b', () => publishOnboardingGenerationProgress('user-1', 'topic-1'));

    expect(published).toHaveLength(2);
    expect(new Set(published).size).toBe(2);
  });

  it('subscribes to the channel its own tenant publishes on', async () => {
    await inTenant('tenant-a', () => publishOnboardingGenerationProgress('user-1', 'topic-1'));
    await inTenant('tenant-a', () => subscribeToOnboardingGenerationProgress('topic-1'));
    await inTenant('tenant-b', () => subscribeToOnboardingGenerationProgress('topic-1'));

    expect(subscribed[0]).toBe(published[0]);
    expect(subscribed[1]).not.toBe(published[0]);
  });
});
