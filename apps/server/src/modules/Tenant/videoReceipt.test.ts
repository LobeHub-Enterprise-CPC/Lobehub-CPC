import { beforeEach, describe, expect, it, vi } from 'vitest';

import { receiveVideoReceipt } from './videoReceipt';

const state = vi.hoisted(() => ({
  rows: [] as any[],
  result: undefined as any,
  write: vi.fn(),
  slug: 'beta' as string | null,
  destroyed: false,
  parse: vi.fn(),
}));
vi.mock('./gate', () => ({ routedTenantSlug: () => state.slug }));
vi.mock('./destruction', () => ({
  withDestructionFence: async (
    db: unknown,
    _tenantId: string,
    refuse: () => Error,
    write: (tx: unknown) => Promise<unknown>,
  ) => {
    if (state.destroyed) throw refuse();
    return write(db);
  },
}));
vi.mock('@lobechat/model-runtime', () => ({
  ModelRuntime: { initializeWithProvider: () => ({ handleCreateVideoWebhook: state.parse }) },
}));
vi.mock('@lobechat/database/platform', async (original) => ({
  ...(await original<object>()),
  getPlatformDB: () => {
    const query: any = {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      limit: async () => state.rows,
    };
    return {
      select: () => query,
      update: () => ({ set: (value: unknown) => ({ where: async () => state.write(value) }) }),
    };
  },
}));
const request = (path = '/api/webhooks/video/volcengine?token=valid') =>
  new Request(`https://app.test${path}`, { method: 'POST', body: '{}' });
beforeEach(() => {
  vi.clearAllMocks();
  state.slug = 'beta';
  state.destroyed = false;
  state.rows = [
    {
      work: {
        workId: 'video:1',
        tenantId: 'beta',
        handle: 'remote-1',
        context: { model: 'model' },
      },
      lifecycle: { desiredState: 'frozen', expiresAt: null, freezeReasons: ['manual'] },
    },
  ];
  state.parse.mockImplementation(async () => state.result);
  state.result = {
    status: 'success',
    inferenceId: 'remote-1',
    videoUrl: 'https://provider.test/result.mp4',
  };
});
describe('video receipt ingress', () => {
  it('accepts a prefixed URL retained by Next.js after tenant routing', async () => {
    expect(
      (await receiveVideoReceipt(request('/orgs/beta/api/webhooks/video/volcengine?token=valid')))
        ?.status,
    ).toBe(200);
  });
  it('accepts authenticated terminal evidence while frozen without tenant admission', async () => {
    expect((await receiveVideoReceipt(request()))?.status).toBe(200);
    expect(state.write).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt: { source: 'authenticated-webhook', result: state.result },
      }),
    );
  });
  it('refuses a receipt for a tenant under destruction and writes nothing', async () => {
    state.destroyed = true;
    const response = (await receiveVideoReceipt(request()))!;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ code: 'TENANT_DESTROYED' });
    expect(state.write).not.toHaveBeenCalled();
  });
  it.each(['pending', 'completed'])('does not mark %s as terminal', async (status) => {
    state.result = { status, inferenceId: 'remote-1' };
    expect((await receiveVideoReceipt(request()))?.status).toBe(status === 'pending' ? 200 : 503);
    expect(state.write).not.toHaveBeenCalled();
  });
  it('rejects a different remote job even with a valid token', async () => {
    state.result.inferenceId = 'other-job';
    expect((await receiveVideoReceipt(request()))?.status).toBe(409);
    expect(state.write).not.toHaveBeenCalled();
  });
  it('keeps unrelated webhooks and unsigned routes on the normal admission path', async () => {
    expect(await receiveVideoReceipt(request('/api/webhooks/github?token=valid'))).toBeUndefined();
    state.slug = null;
    expect(await receiveVideoReceipt(request())).toBeUndefined();
    expect(state.parse).not.toHaveBeenCalled();
  });
  it('does not parse or acknowledge an unrecognized tenant/provider/token', async () => {
    state.rows = [];
    expect(await receiveVideoReceipt(request())).toBeUndefined();
    expect(state.parse).not.toHaveBeenCalled();
  });
});
