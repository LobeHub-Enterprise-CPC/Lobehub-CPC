// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type * as HatchetConfig from '@/server/modules/Hatchet/config';

import { reapOperations } from '../reapOperations';

const mocks = vi.hoisted(() => ({
  deliveryProbe: async () => 'none' as const,
  hatchetDelivery: false,
  reapers: [] as { db: unknown; options: unknown }[],
}));

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: async () => 'server-db' }));
vi.mock('@/server/modules/Hatchet/config', async (importOriginal) => ({
  ...(await importOriginal<typeof HatchetConfig>()),
  isHatchetDeliveryEnabled: () => mocks.hatchetDelivery,
}));
vi.mock('@/server/modules/Hatchet/probe', () => ({
  createHatchetDeliveryProbe: () => mocks.deliveryProbe,
}));
vi.mock('@/server/services/agentRuntime', () => ({
  StaleOperationReaper: class {
    constructor(db: unknown, options: unknown) {
      mocks.reapers.push({ db, options });
    }
    sweep = async () => ({ examined: 0, failed: 0 });
  },
}));

const context = () =>
  ({
    json: (body: unknown, status = 200) => ({ body, status }),
    req: { query: () => undefined },
  }) as never;

describe('reapOperations handler', () => {
  it.each([
    [true, mocks.deliveryProbe],
    [false, undefined],
  ])('asks Hatchet before redriving only in Hatchet delivery mode (%s)', async (enabled, probe) => {
    mocks.hatchetDelivery = enabled;
    mocks.reapers.length = 0;

    const response = (await reapOperations(context())) as unknown as { status: number };

    expect(response.status).toBe(200);
    expect(mocks.reapers).toEqual([{ db: 'server-db', options: { deliveryProbe: probe } }]);
  });
});
