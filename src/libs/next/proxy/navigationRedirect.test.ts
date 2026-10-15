/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  handleNavigationRedirect,
  MAX_NAVIGATION_REDIRECT_HEADER_LENGTH,
  NAVIGATION_REDIRECT_HEADER,
  navigationRedirect,
  signNavigationRedirect,
} from './navigationRedirect';

const secret = process.env.KEY_VAULTS_SECRET;
beforeEach(() => {
  process.env.KEY_VAULTS_SECRET = 'navigation-redirect-test-secret';
});
afterEach(() => {
  if (secret === undefined) delete process.env.KEY_VAULTS_SECRET;
  else process.env.KEY_VAULTS_SECRET = secret;
});

const reach = (value?: string | null) =>
  handleNavigationRedirect(
    new Request('http://localhost:3010/api/internal/navigation-redirect', {
      headers: value ? { [NAVIGATION_REDIRECT_HEADER]: value } : {},
    }),
  );

describe('fragment-clearing navigation redirect', () => {
  it.each([
    'http://localhost:3010/?switch=1#',
    'https://chat.example.com/t/acme/#',
    'https://chat.example.com/oidc/auth?state=authorized#',
  ])('answers 302 with a Location that keeps its empty fragment: %s', (location) => {
    const response = reach(signNavigationRedirect(location));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(location);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('refuses a missing, unsigned, tampered or foreign-key value', () => {
    const signed = signNavigationRedirect('http://localhost:3010/#')!;
    const [payload, mac] = signed.split('.');
    const forged = Buffer.from('https://evil.example/#').toString('base64url');
    process.env.KEY_VAULTS_SECRET = 'another-deployment-secret';
    const foreign = signNavigationRedirect('http://localhost:3010/#')!;
    process.env.KEY_VAULTS_SECRET = 'navigation-redirect-test-secret';
    for (const value of [null, '', payload, `${forged}.${mac}`, `${payload}.`, foreign]) {
      const response = reach(value);
      expect(response.status).toBe(404);
      expect(response.headers.get('location')).toBeNull();
    }
  });

  it('only signs absolute http(s) targets that end in an empty fragment', () => {
    for (const location of [
      'http://localhost:3010/',
      'http://localhost:3010/#x',
      '/relative#',
      'javascript:alert(1)#',
      'ftp://chat.example.com/#',
      'https://user:pass@chat.example.com/#',
    ])
      expect(signNavigationRedirect(location)).toBeNull();
  });

  it('cannot sign without the deployment secret', () => {
    delete process.env.KEY_VAULTS_SECRET;
    expect(signNavigationRedirect('http://localhost:3010/#')).toBeNull();
  });

  it('bounds the accepted header length on both sides', () => {
    const long = `https://chat.example.com/${'a'.repeat(9000)}#`;
    expect(signNavigationRedirect(long)).toBeNull();
    const valid = signNavigationRedirect('http://localhost:3010/#')!;
    const response = reach(`${valid}${'A'.repeat(MAX_NAVIGATION_REDIRECT_HEADER_LENGTH)}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
    expect(reach(valid).status).toBe(302);
  });
});

describe('proxy answer when the redirect cannot be signed', () => {
  const request = new Request('http://localhost:3010/signin');
  const unusable = (response: Response) => {
    expect(response.status).toBe(503);
    expect(response.status < 300 || response.status >= 400).toBe(true);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  };

  it('fails closed without the deployment secret instead of sending a plain 302', () => {
    delete process.env.KEY_VAULTS_SECRET;
    unusable(navigationRedirect(request, new Headers(), 'http://localhost:3010/?switch=1#'));
  });

  it('rejects a target too long to hand over', () => {
    unusable(
      navigationRedirect(request, new Headers(), `https://chat.example.com/${'a'.repeat(9000)}#`),
    );
  });

  it.each([
    'http://localhost:3010/',
    'http://localhost:3010/#x',
    '/relative#',
    'javascript:alert(1)#',
  ])('rejects the unacceptable target %s', (location) => {
    unusable(navigationRedirect(request, new Headers(), location));
  });

  it('still hands an acceptable target to the route handler', () => {
    const response = navigationRedirect(request, new Headers(), 'http://localhost:3010/#');
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-rewrite')).toContain(
      '/api/internal/navigation-redirect',
    );
  });
});
