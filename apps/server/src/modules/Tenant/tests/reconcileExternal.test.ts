// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reconcileExternalWork } from '../reconcileExternal';

const state = vi.hoisted(() => ({ baseURL: '', work: undefined as any, write: vi.fn() }));
vi.mock('@/envs/sandbox', () => ({
  sandboxEnv: {
    get ONLYBOXES_BASE_URL() {
      return state.baseURL;
    },
    ONLYBOXES_JIT_SIGNING_KEY: 'local-fixture',
  },
}));
vi.mock('@lobechat/database/platform', async (original) => ({
  ...(await original<object>()),
  getPlatformDB: () => {
    const query: any = {
      from: () => query,
      where: () => query,
      limit: async () => (state.work ? [state.work] : []),
    };
    return {
      select: () => query,
      update: () => ({ set: (value: unknown) => ({ where: async () => state.write(value) }) }),
    };
  },
}));
describe('operator reconciliation against a local HTTP provider', () => {
  let server: Server;
  let status: string | undefined;
  let httpStatus: number;
  beforeEach(async () => {
    vi.clearAllMocks();
    status = 'running';
    httpStatus = 200;
    state.work = {
      workId: 'sandbox:fixture',
      tenantId: 'beta',
      kind: 'sandbox',
      handle: JSON.stringify(['beta', 'onlyboxes', 'user', 'topic', null, 'remote-command']),
    };
    server = createServer((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/api/v1/tasks/remote-command');
      res.writeHead(httpStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it.each(['running', 'pending', undefined, 'unknown'])(
    'retains unresolved work with state %s',
    async (remoteState) => {
      status = remoteState;
      expect(await reconcileExternalWork('sandbox:fixture')).toMatchObject({ terminal: false });
      expect(state.write).not.toHaveBeenCalled();
    },
  );
  it.each([404, 500])('does not infer destruction from HTTP %s', async (code) => {
    httpStatus = code;
    expect(await reconcileExternalWork('sandbox:fixture')).toMatchObject({ terminal: false });
    expect(state.write).not.toHaveBeenCalled();
  });
  it.each(['succeeded', 'failed', 'cancelled'])(
    'stores positive terminal evidence for %s',
    async (remoteState) => {
      status = remoteState;
      expect(await reconcileExternalWork('sandbox:fixture')).toMatchObject({ terminal: true });
      expect(state.write).toHaveBeenCalledWith(
        expect.objectContaining({
          completedAt: expect.any(Date),
          receipt: expect.objectContaining({ source: 'operator-provider-query' }),
        }),
      );
    },
  );
  it('retains lost submissions without a provider lookup handle', async () => {
    state.work.handle = null;
    await expect(reconcileExternalWork('sandbox:fixture')).rejects.toThrow('HANDLE_UNKNOWN');
    expect(state.write).not.toHaveBeenCalled();
  });
});
