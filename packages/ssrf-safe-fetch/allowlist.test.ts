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

  // A list mixing IPv4 and IPv6 CIDRs is valid: an entry of the other address family is
  // simply not a match. request-filtering-agent 3.2.1 reported it as an "Invalid CIDR"
  // on every lookup (e.g. an IPv4 VPC range checked against an AAAA record).
  describe('mixed address families', () => {
    const listen = async (host: string) => {
      const server = createServer((_request, response) => response.end('allowed'));
      await new Promise<void>((resolve) => server.listen(0, host, resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('TCP address required');
      return {
        close: () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
        port: address.port,
      };
    };

    const invalidCidrWarnings = (warn: { mock: { calls: unknown[][] } }) =>
      warn.mock.calls.filter(([message]) => String(message).includes('Invalid CIDR'));

    it('matches an IPv6 target against IPv6 entries without warning about IPv4 ones', async () => {
      vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '0');
      vi.stubEnv('SSRF_ALLOW_IP_ADDRESS_LIST', '172.20.16.0/20,::1/128');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const server = await listen('::1');

      try {
        const response = await ssrfSafeFetch(`http://[::1]:${server.port}`);
        expect(await response.text()).toBe('allowed');
        expect(invalidCidrWarnings(warn)).toEqual([]);
      } finally {
        await server.close();
      }
    });

    it('still blocks an unlisted IPv6 target without warning', async () => {
      vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '0');
      vi.stubEnv('SSRF_ALLOW_IP_ADDRESS_LIST', '172.20.16.0/20,192.168.44.0/22');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const server = await listen('::1');

      try {
        await expect(ssrfSafeFetch(`http://[::1]:${server.port}`)).rejects.toThrow(/SSRF blocked/);
        expect(invalidCidrWarnings(warn)).toEqual([]);
      } finally {
        await server.close();
      }
    });

    it('matches an IPv4 target against IPv4 entries without warning about IPv6 ones', async () => {
      vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '0');
      vi.stubEnv('SSRF_ALLOW_IP_ADDRESS_LIST', 'fd00::/8,127.0.0.0/8');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const server = await listen('127.0.0.1');

      try {
        const response = await ssrfSafeFetch(`http://127.0.0.1:${server.port}`);
        expect(await response.text()).toBe('allowed');
        expect(invalidCidrWarnings(warn)).toEqual([]);
      } finally {
        await server.close();
      }
    });
  });
});
