import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ssrfSafeFetch } from './index';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('deployment IP allowlist', () => {
  it('allows a listed private IP with whitespace while blocking an unlisted one', async () => {
    vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '0');
    vi.stubEnv('SSRF_ALLOW_IP_ADDRESS_LIST', ' , 127.0.0.1 , , 10.0.0.8  , ');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = createServer((_request, response) => response.end('allowed'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP address required');

    try {
      const response = await ssrfSafeFetch(`http://127.0.0.1:${address.port}`);
      expect(await response.text()).toBe('allowed');
      await expect(ssrfSafeFetch(`http://127.0.0.2:${address.port}`)).rejects.toThrow(
        /SSRF blocked/,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
