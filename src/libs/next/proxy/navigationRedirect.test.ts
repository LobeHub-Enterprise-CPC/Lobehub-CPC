/**
 * @vitest-environment node
 */
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  handleNavigationRedirect,
  NAVIGATION_REDIRECT_HEADER,
  NAVIGATION_REDIRECT_PATH,
  navigationRedirect,
  signNavigationRedirect,
} from './navigationRedirect';
import type { TenantMiddlewareDeps } from './tenant/types';

const deps: TenantMiddlewareDeps = {
  defaultMiddleware: () => {
    throw new Error('not used');
  },
  isPublicRoute: () => false,
  toSafeLocale: () => 'en-US',
};

const documentHeaders = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
const request = (headers: Record<string, string> = {}) =>
  new Request('http://localhost:3010/api/internal/navigation-redirect', {
    headers: { ...documentHeaders, ...headers },
  });
const signed = (location: string) => {
  const value = signNavigationRedirect(location);
  expect(value).not.toBeNull();
  return value!;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('signed navigation redirect handler', () => {
  it.each([
    'http://localhost:3010/?switch=1#',
    'https://chat.example.com/orgs/acme/#',
    'https://chat.example.com/oidc/auth?state=authorized&a=b#',
  ])('answers a real 302 with the exact fragment-clearing target: %s', async (location) => {
    vi.stubEnv('KEY_VAULTS_SECRET', 'test-navigation-secret');
    const response = handleNavigationRedirect(
      request({ [NAVIGATION_REDIRECT_HEADER]: signed(location) }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(location);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
  });

  it.each([
    ['no signed header', () => request()],
    ['a forged value', () => request({ [NAVIGATION_REDIRECT_HEADER]: 'forged' })],
    [
      'a tampered MAC',
      () => {
        const value = signed('http://localhost:3010/?switch=1#');
        const tampered = `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
        return request({ [NAVIGATION_REDIRECT_HEADER]: tampered });
      },
    ],
    [
      'a tampered payload',
      () => {
        const [payload, mac] = signed('http://localhost:3010/?switch=1#').split('.');
        const tampered = `${payload.startsWith('a') ? 'b' : 'a'}${payload.slice(1)}.${mac}`;
        return request({ [NAVIGATION_REDIRECT_HEADER]: tampered });
      },
    ],
    [
      'an oversized value',
      () => request({ [NAVIGATION_REDIRECT_HEADER]: `${'a'.repeat(8193)}.b` }),
    ],
  ])('answers 404 for %s', (_name, build) => {
    vi.stubEnv('KEY_VAULTS_SECRET', 'test-navigation-secret');
    expect(handleNavigationRedirect(build()).status).toBe(404);
  });

  it.each([
    ['without Fetch Metadata', {}],
    ['POST', documentHeaders],
    ['a prefetch', { ...documentHeaders, purpose: 'prefetch' }],
    ['an RSC fetch', { 'rsc': '1', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' }],
  ])('answers 404 for a %s request even with a valid signature', (_name, headers) => {
    vi.stubEnv('KEY_VAULTS_SECRET', 'test-navigation-secret');
    const value = signed('http://localhost:3010/?switch=1#');
    const method = _name === 'POST' ? 'POST' : 'GET';
    const response = handleNavigationRedirect(
      new Request('http://localhost:3010/api/internal/navigation-redirect', {
        body: method === 'POST' ? '' : undefined,
        headers: { ...headers, [NAVIGATION_REDIRECT_HEADER]: value },
        method,
      }),
    );
    expect(response.status).toBe(404);
  });

  it('fails closed when the signing key is missing', () => {
    vi.stubEnv('KEY_VAULTS_SECRET', 'test-navigation-secret');
    const value = signed('http://localhost:3010/?switch=1#');
    vi.stubEnv('KEY_VAULTS_SECRET', undefined);
    expect(signNavigationRedirect('http://localhost:3010/?switch=1#')).toBeNull();
    expect(handleNavigationRedirect(request({ [NAVIGATION_REDIRECT_HEADER]: value })).status).toBe(
      404,
    );
  });
});

describe('proxy navigation redirect', () => {
  it('rewrites to the internal route with a signed target instead of returning a page', async () => {
    vi.stubEnv('KEY_VAULTS_SECRET', 'test-navigation-secret');
    const response = await navigationRedirect(
      deps,
      new NextRequest('http://localhost:3010/signin?email=private@example.com', {
        headers: documentHeaders,
      }),
      new Headers(),
      'http://localhost:3010/?switch=1#',
    );
    const rewrite = response.headers.get('x-middleware-rewrite');
    expect(new URL(rewrite!).pathname).toBe(NAVIGATION_REDIRECT_PATH);
    expect(new URL(rewrite!).search).toBe('');
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(
      handleNavigationRedirect(
        request({
          [NAVIGATION_REDIRECT_HEADER]: response.headers.get(
            `x-middleware-request-${NAVIGATION_REDIRECT_HEADER}`,
          )!,
        }),
      ).headers.get('location'),
    ).toBe('http://localhost:3010/?switch=1#');
  });

  it('replaces a client-supplied copy of the signed header', async () => {
    vi.stubEnv('KEY_VAULTS_SECRET', 'test-navigation-secret');
    const response = await navigationRedirect(
      deps,
      new NextRequest('http://localhost:3010/', { headers: documentHeaders }),
      new Headers({ [NAVIGATION_REDIRECT_HEADER]: 'forged' }),
      'https://chat.example.com/#',
    );
    const forwarded = response.headers.get(`x-middleware-request-${NAVIGATION_REDIRECT_HEADER}`);
    expect(forwarded).not.toBe('forged');
    expect(forwarded).toBe(signed('https://chat.example.com/#'));
  });

  it.each([
    'http://localhost:3010/',
    'http://localhost:3010/#x',
    '/relative#',
    'javascript:alert(1)//#',
    'https://user:pass@chat.example.com/#',
    'https://chat.example.com/a b#',
    `http://localhost:3010/${'a'.repeat(9000)}#`,
  ])('fails closed with a 503 and no Location for %s', async (location) => {
    vi.stubEnv('KEY_VAULTS_SECRET', 'test-navigation-secret');
    const response = await navigationRedirect(
      deps,
      new NextRequest('http://localhost:3010/'),
      new Headers(),
      location,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    expect(await response.text()).toContain('href="/#"');
  });

  it('fails closed with a 503 and no Location when the signing key is missing', async () => {
    vi.stubEnv('KEY_VAULTS_SECRET', undefined);
    const response = await navigationRedirect(
      deps,
      new NextRequest('http://localhost:3010/'),
      new Headers(),
      'https://chat.example.com/__entry#',
      'https://chat.example.com/__entry#',
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    expect(await response.text()).toContain('href="https://chat.example.com/__entry#"');
  });
});
