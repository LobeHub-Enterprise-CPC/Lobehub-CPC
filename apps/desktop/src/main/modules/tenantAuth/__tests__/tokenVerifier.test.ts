import crypto from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createJwksResolver,
  pickAccountDisplay,
  readTenantDisplayClaims,
  readTenantId,
  TokenVerificationError,
  verifyAccessToken,
  verifyIdToken,
} from '../tokenVerifier';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock('@/utils/net-fetch', () => ({ netFetch: mockFetch }));

const ISSUER = 'https://platform.example/orgs/acme/oidc';
const NOW = 1_800_000_000_000;
const START = NOW - 60_000;

const makeKey = (kid: string) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return { jwk: { ...jwk, alg: 'RS256', kid, use: 'sig' }, privateKey };
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const sign = (
  privateKey: crypto.KeyObject,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
) => {
  const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header });
  const body = b64(payload);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${signature.toString('base64url')}`;
};

const idClaims = (extra: Record<string, unknown> = {}) => ({
  aud: 'tituwork-desktop',
  exp: NOW / 1000 + 600,
  iat: NOW / 1000 - 10,
  iss: ISSUER,
  sub: 'user-1',
  ...extra,
});

const jwksResponse = (...keys: unknown[]) =>
  new Response(JSON.stringify({ keys }), { headers: { 'content-type': 'application/json' } });

describe('tokenVerifier', () => {
  let key: ReturnType<typeof makeKey>;

  beforeEach(() => {
    mockFetch.mockReset();
    key = makeKey('k1');
    mockFetch.mockImplementation(async () => jwksResponse(key.jwk));
  });

  const verifyId = (token: string, jwks = createJwksResolver({ now: () => NOW })) =>
    verifyIdToken({ expectedIssuer: ISSUER, jwks, notBefore: START, now: NOW, token });

  it('accepts a valid id token and reads keys only from the bound issuer, without redirects', async () => {
    const result = await verifyId(sign(key.privateKey, idClaims({ email: 'a@b.c' })));

    expect(result.claims.sub).toBe('user-1');
    expect(mockFetch).toHaveBeenCalledWith(
      `${ISSUER}/jwks`,
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it.each([
    ['a bad signature', () => sign(makeKey('k1').privateKey, idClaims())],
    ['another issuer', () => sign(key.privateKey, idClaims({ iss: 'https://evil.example/oidc' }))],
    ['another audience', () => sign(key.privateKey, idClaims({ aud: 'someone-else' }))],
    [
      'a multi-value audience',
      () => sign(key.privateKey, idClaims({ aud: ['tituwork-desktop', 'x'] })),
    ],
    ['a foreign authorized party', () => sign(key.privateKey, idClaims({ azp: 'other' }))],
    ['an expired token', () => sign(key.privateKey, idClaims({ exp: NOW / 1000 - 1 }))],
    [
      'exp not after iat',
      () => sign(key.privateKey, idClaims({ exp: NOW / 1000 - 10, iat: NOW / 1000 - 10 })),
    ],
    [
      'an iat older than the authorization',
      () => sign(key.privateKey, idClaims({ iat: START / 1000 - 3600 })),
    ],
    ['an iat in the future', () => sign(key.privateKey, idClaims({ iat: NOW / 1000 + 3600 }))],
    ['a non-numeric exp', () => sign(key.privateKey, idClaims({ exp: '9999999999' }))],
    ['an empty subject', () => sign(key.privateKey, idClaims({ sub: '' }))],
    ['a non-RS256 alg', () => sign(key.privateKey, idClaims(), { alg: 'HS256' })],
    ['alg none', () => sign(key.privateKey, idClaims(), { alg: 'none' })],
    ['a crit header', () => sign(key.privateKey, idClaims(), { crit: ['b64'] })],
    ['a missing kid', () => sign(key.privateKey, idClaims(), { kid: undefined })],
    ['garbage', () => 'not-a-jwt'],
  ])('rejects %s', async (_name, build) => {
    await expect(verifyId(build())).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('ignores jku / x5u / embedded jwk headers and still uses the bound JWKS', async () => {
    const attacker = makeKey('k1');
    const token = sign(attacker.privateKey, idClaims(), {
      jku: 'https://evil.example/jwks',
      jwk: attacker.jwk,
      x5u: 'https://evil.example/cert',
    });

    await expect(verifyId(token)).rejects.toBeInstanceOf(TokenVerificationError);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([`${ISSUER}/jwks`]);
  });

  it('refreshes the JWKS once for an unknown kid, then rejects', async () => {
    const jwks = createJwksResolver({ now: () => NOW });
    await verifyId(sign(key.privateKey, idClaims()), jwks);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const unknown = sign(key.privateKey, idClaims(), { kid: 'rotated' });
    await expect(verifyId(unknown, jwks)).rejects.toThrow('Unknown signing key');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('picks up a rotated key through the single refresh', async () => {
    const jwks = createJwksResolver({ now: () => NOW });
    await verifyId(sign(key.privateKey, idClaims()), jwks);

    const rotated = makeKey('k2');
    mockFetch.mockImplementation(async () => jwksResponse(key.jwk, rotated.jwk));

    await expect(
      verifyId(sign(rotated.privateKey, idClaims(), { kid: 'k2' }), jwks),
    ).resolves.toBeDefined();
  });

  it('rejects when several keys match the kid', async () => {
    mockFetch.mockImplementation(async () => jwksResponse(key.jwk, { ...key.jwk }));

    await expect(verifyId(sign(key.privateKey, idClaims()))).rejects.toThrow('Ambiguous');
  });

  it('keeps JWKS caches separate per issuer', async () => {
    const jwks = createJwksResolver({ now: () => NOW });
    await verifyId(sign(key.privateKey, idClaims()), jwks);

    const other = makeKey('k1');
    mockFetch.mockImplementation(async () => jwksResponse(other.jwk));
    const otherIssuer = 'https://other.example/oidc';

    await expect(
      verifyIdToken({
        expectedIssuer: otherIssuer,
        jwks,
        notBefore: START,
        now: NOW,
        token: sign(key.privateKey, idClaims({ iss: otherIssuer })),
      }),
    ).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('refuses a JWKS over http (outside development loopback) and a redirecting JWKS', async () => {
    const insecure = 'http://platform.example/orgs/acme/oidc';
    await expect(
      verifyIdToken({
        expectedIssuer: insecure,
        jwks: createJwksResolver(),
        notBefore: START,
        now: NOW,
        token: sign(key.privateKey, idClaims({ iss: insecure })),
      }),
    ).rejects.toThrow('https');
    expect(mockFetch).not.toHaveBeenCalled();

    mockFetch.mockRejectedValue(new TypeError('redirect mode is set to error'));
    await expect(verifyId(sign(key.privateKey, idClaims()))).rejects.toThrow('redirect');
  });

  it('allows a loopback http JWKS only when explicitly enabled', async () => {
    const loopback = 'http://127.0.0.1:3210/oidc';
    const token = sign(key.privateKey, idClaims({ iss: loopback }));

    await expect(
      verifyIdToken({
        expectedIssuer: loopback,
        jwks: createJwksResolver({ allowLoopbackHttp: true }),
        notBefore: START,
        now: NOW,
        token,
      }),
    ).resolves.toBeDefined();
  });

  it('verifies the access token against its own audience and reads the tenant claim', async () => {
    const claims = {
      aud: 'urn:lobehub:chat',
      exp: NOW / 1000 + 600,
      iat: NOW / 1000 - 10,
      iss: ISSUER,
      sub: 'user-1',
      tid: 'tenant-1',
    };
    const jwks = createJwksResolver({ now: () => NOW });
    const verify = (payload: Record<string, unknown>) =>
      verifyAccessToken({
        expectedIssuer: ISSUER,
        jwks,
        notBefore: START,
        now: NOW,
        token: sign(key.privateKey, payload),
      });

    expect(readTenantId((await verify(claims)).claims)).toBe('tenant-1');
    await expect(verify({ ...claims, aud: 'tituwork-desktop' })).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
    expect(readTenantId({ ...claims, tid: '' })).toBeNull();
    expect(readTenantId({ ...claims, tid: 7 })).toBeNull();
  });

  it('displays email, then preferred_username, then sub', () => {
    expect(pickAccountDisplay({ email: 'a@b.c', preferred_username: 'a', sub: 's' })).toBe('a@b.c');
    expect(pickAccountDisplay({ preferred_username: 'alice', sub: 's' })).toBe('alice');
    expect(pickAccountDisplay({ email: '  ', sub: 'sub-9' })).toBe('sub-9');
  });
  describe('readTenantDisplayClaims', () => {
    it('reads the three display claims when they are valid', () => {
      expect(
        readTenantDisplayClaims({
          has_other_organizations: true,
          tenant_name: 'Acme Inc',
          tenant_slug: 'acme-2',
        }),
      ).toEqual({ hasOtherOrganizations: true, name: 'Acme Inc', slug: 'acme-2' });
      expect(readTenantDisplayClaims({ has_other_organizations: false })).toEqual({
        hasOtherOrganizations: false,
      });
    });

    it('treats missing claims as unknown', () => {
      expect(readTenantDisplayClaims({ sub: 's' })).toEqual({});
    });

    it.each([
      ['an empty name', { tenant_name: '' }],
      ['a non-string name', { tenant_name: 7 }],
      ['an oversized name', { tenant_name: 'a'.repeat(4097) }],
      ['an empty slug', { tenant_slug: '' }],
      ['a slug with upper case', { tenant_slug: 'Acme' }],
      ['a slug starting with a digit', { tenant_slug: '1acme' }],
      ['a slug with a trailing dash', { tenant_slug: 'acme-' }],
      ['a slug with a double dash', { tenant_slug: 'a--b' }],
      ['a slug with a slash', { tenant_slug: 'a/b' }],
      ['a non-string slug', { tenant_slug: ['acme'] }],
      ['an oversized slug', { tenant_slug: `a${'b'.repeat(128)}` }],
      ['a string flag', { has_other_organizations: 'true' }],
      ['a numeric flag', { has_other_organizations: 1 }],
      ['a null flag', { has_other_organizations: null }],
    ])('drops %s without failing', (_name, claims) => {
      expect(readTenantDisplayClaims(claims)).toEqual({});
    });

    it('keeps valid claims when a sibling is invalid', () => {
      expect(
        readTenantDisplayClaims({
          has_other_organizations: 'x',
          tenant_name: 'Acme',
          tenant_slug: 'A',
        }),
      ).toEqual({ name: 'Acme' });
    });

    it('accepts boundary lengths', () => {
      const slug = `a${'b'.repeat(127)}`;
      const name = 'n'.repeat(4096);
      expect(readTenantDisplayClaims({ tenant_name: name, tenant_slug: slug })).toEqual({
        name,
        slug,
      });
    });
  });
});
