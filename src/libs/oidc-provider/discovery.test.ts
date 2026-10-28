// @vitest-environment node
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import Provider from 'oidc-provider';
import { expect, it } from 'vitest';

import { OIDC_ROUTES } from './routes';

it.each(['/orgs/acme', ''])(
  'advertises reachable OIDC endpoints beneath the active entry %s',
  async (basePath) => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const issuer = `${origin}${basePath}/oidc`;
    try {
      const provider = new Provider(issuer, {
        cookies: { keys: ['isolated-discovery-test-key'] },
        features: {
          devInteractions: { enabled: false },
          introspection: { enabled: true },
          revocation: { enabled: true },
        },
        routes: Object.fromEntries(
          Object.entries(OIDC_ROUTES).map(([name, route]) => [name, `${basePath}${route}`]),
        ),
      });
      server.on('request', provider.callback());
      const discovery = await fetch(`${origin}/.well-known/openid-configuration`).then((response) =>
        response.json(),
      );
      expect(discovery.issuer).toBe(issuer);
      const endpoints = Object.entries(discovery).filter(
        ([name]) => name.endsWith('_endpoint') || name === 'jwks_uri',
      );
      expect(endpoints.length).toBeGreaterThan(5);
      for (const [, url] of endpoints)
        expect(String(url)).toMatch(
          new RegExp(`^${issuer.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`),
        );
      for (const [name, url] of endpoints) {
        const method = [
          'token_endpoint',
          'introspection_endpoint',
          'revocation_endpoint',
          'pushed_authorization_request_endpoint',
        ].includes(name)
          ? 'POST'
          : 'GET';
        const response = await fetch(String(url), { method, redirect: 'manual' });
        expect(response.status, name).not.toBe(404);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
