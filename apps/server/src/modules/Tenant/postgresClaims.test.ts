// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  lifecycles: [
    {
      tenantId: 't',
      acceptedVersion: 2,
      desiredState: 'frozen',
      freezeReasons: [],
      expiresAt: null,
    },
  ],
  writes: [] as Record<string, unknown>[],
  invalidate: vi.fn(),
}));
vi.mock('./runtime', () => ({ getTenantRuntime: () => ({ invalidate: state.invalidate }) }));
vi.mock('@lobechat/database/platform', async (original) => {
  const exports = await original<object>();
  const db = {
    select: () => ({ from: async () => state.lifecycles }),
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          state.writes.push(value);
        },
      }),
    }),
    delete: () => ({ where: async () => {} }),
    transaction: async (run: (tx: unknown) => Promise<void>) => run(db),
  };
  return { ...exports, getPlatformDB: () => db };
});
const { tenantClaims, tenantProcessLease } = await import('./postgresClaims');

beforeEach(() => {
  state.writes.length = 0;
});

describe('heartbeat generation receipts', () => {
  it('writes only at heartbeat, withholds the receipt while requests remain, and reports the generation after release', async () => {
    const first = await tenantClaims.enter('t');
    const child = tenantClaims.bind('t');
    const startupWrites = state.writes.length;
    for (let n = 0; n < 20; n++) {
      const done = await tenantClaims.enter('t');
      await done();
    }
    expect(state.writes).toHaveLength(startupWrites);
    await tenantProcessLease.heartbeat();
    expect(state.writes.at(-1)?.drainedGenerations).toEqual({});
    await first();
    await tenantProcessLease.heartbeat();
    expect(state.writes.at(-1)?.drainedGenerations).toEqual({});
    await child();
    await tenantProcessLease.heartbeat();
    expect(state.writes.at(-1)?.drainedGenerations).toEqual({ t: 2 });
    expect(state.invalidate).toHaveBeenCalledWith('t');
    await tenantProcessLease.stop();
  });
});
