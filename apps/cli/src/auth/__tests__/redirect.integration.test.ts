import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { getUserIdFromApiKey } from '../apiKey';
import { getValidToken } from '../refresh';

const state = vi.hoisted(() => ({ entry: '' }));
vi.mock('../credentials', () => ({
  loadCredentials: () => ({
    accessToken: 'TEST-OLD',
    refreshToken: 'TEST-ONLY',
    expiresAt: 0,
    serverUrl: state.entry,
  }),
  saveCredentials: vi.fn(),
}));
vi.mock('../../settings', () => ({
  resolveServerUrl: () => state.entry,
  normalizeUrl: (url?: string) => url?.replace(/\/$/, ''),
}));

/** A credential-carrying entry must never follow a redirect before gateway identity exchange. */
describe('CLI original credential HTTP entry', () => {
  it('keeps API keys and OIDC refresh credentials away from a redirect sink', async () => {
    let redirectedRequests = 0;
    const server = createServer((req, res) => {
      if (req.url === '/sink') {
        redirectedRequests++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ data: { id: 'same-sub' }, access_token: 'TEST-ONLY', expires_in: 3600 }),
        );
      } else res.writeHead(307, { Location: '/sink' }).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const entry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/t/a`;
    state.entry = entry;
    try {
      let acceptedKey = false;
      try {
        await getUserIdFromApiKey('TEST-ONLY', entry);
        acceptedKey = true;
      } catch {
        /* rejected entry */
      }
      const refresh = await getValidToken();
      expect({ acceptedKey, refresh: refresh.status, redirectedRequests }).toEqual({
        acceptedKey: false,
        refresh: 'unavailable',
        redirectedRequests: 0,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
