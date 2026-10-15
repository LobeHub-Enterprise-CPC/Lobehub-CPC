import { describe, expect, it } from 'vitest';

import {
  clearTenantCookie,
  isDocumentNavigation,
  isValidTenantId,
  redactUrlEmail,
  serializeTenantCookie,
  tenantCookieName,
} from './navigation';

const documentHeaders = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const request = (headers: Record<string, string> = documentHeaders, method = 'GET') => ({
  method,
  headers: new Headers(headers),
});

describe('tenant navigation preference', () => {
  it('consumes only explicit document GET navigation, excluding speculative and non-document requests', () => {
    expect(isDocumentNavigation(request())).toBe(true);
    for (const method of ['HEAD', 'POST'])
      expect(isDocumentNavigation(request(documentHeaders, method))).toBe(false);
    for (const headers of [
      {},
      { ...documentHeaders, 'sec-fetch-mode': 'cors' },
      { ...documentHeaders, 'sec-fetch-dest': 'empty' },
      ...['purpose', 'sec-purpose'].map((name) => ({
        ...documentHeaders,
        [name]: 'prefetch;prerender',
      })),
    ])
      expect(isDocumentNavigation(request(headers))).toBe(false);
  });
  it('uses a host-only secure preference for HTTPS and a local HTTP name', () => {
    expect(tenantCookieName('https://app.example.com')).toBe('__Host-lobe-last-tenant');
    expect(serializeTenantCookie('tenant:1', 'https://app.example.com')).toBe(
      '__Host-lobe-last-tenant=tenant:1; Path=/; Max-Age=15552000; HttpOnly; SameSite=Lax; Secure',
    );
    expect(serializeTenantCookie('tenant-1', 'http://localhost:3010')).toBe(
      'lobe-last-tenant=tenant-1; Path=/; Max-Age=15552000; HttpOnly; SameSite=Lax',
    );
    expect(clearTenantCookie('https://app.example.com')).toContain('Max-Age=0;');
  });
  it('validates the control-plane id grammar and prevents cookie injection', () => {
    for (const value of ['a', 'tenant_1', 'id.1:part-2', 'a'.repeat(128)])
      expect(isValidTenantId(value)).toBe(true);
    for (const value of ['', 'a'.repeat(129), 'x; Domain=evil', 'x\r\nSet-Cookie:y', 'x/y']) {
      expect(isValidTenantId(value)).toBe(false);
      expect(() => serializeTenantCookie(value, 'https://app.example.com')).toThrow();
    }
  });
  it('redacts every email query value without changing navigation fields', () => {
    const logged = redactUrlEmail(
      'https://app.example.com/signin?email=private%40example.com&email=second&hl=en-US',
    );
    expect(logged).not.toContain('private');
    expect(logged).not.toContain('second');
    expect(new URL(logged).searchParams.get('hl')).toBe('en-US');
  });
});

describe('desktop URL privacy', () => {
  it('redacts desktop handoff state carried as id without hiding ordinary resource ids', () => {
    for (const prefix of ['https://chat.example.com', 'https://app.example.com/t/acme']) {
      const logged = redactUrlEmail(`${prefix}/oidc/handoff?id=private-state&client=desktop`);
      expect(logged).not.toContain('private-state');
      expect(new URL(logged).searchParams.get('client')).toBe('desktop');
    }
    expect(
      new URL(redactUrlEmail('https://app.example.com/agent?id=resource-id')).searchParams.get(
        'id',
      ),
    ).toBe('resource-id');
  });

  it('redacts state, challenge, codes, tokens and nested callback URLs', () => {
    const nested =
      'https://app.example.com/t/acme/oidc/auth?state=private-state&code_challenge=private-challenge';
    const url = new URL('https://app.example.com/signin?hl=en-US');
    for (const [key, value] of Object.entries({
      state: 'private-state',
      code_challenge: 'private-challenge',
      code: 'private-code',
      CODE: 'private-uppercase-code',
      code_verifier: 'private-verifier',
      token: 'private-token',
      callbackUrl: nested,
      returnTo: '/oidc/auth?state=private-nested-state',
      redirect_uri: nested,
    }))
      url.searchParams.set(key, value);
    url.hash = 'private-fragment';
    const logged = redactUrlEmail(url.href);
    expect(logged).not.toContain('private');
    expect(new URL(logged).searchParams.get('hl')).toBe('en-US');
  });
  it('redacts server-relative URLs with the same rules and keeps them relative', () => {
    const logged = redactUrlEmail(
      '/t/acme/oidc/session/end?id_token_hint=private-id-token&state=private-state&hl=en-US#private-fragment',
    );
    expect(logged).not.toContain('private');
    expect(logged.startsWith('/t/acme/oidc/session/end?')).toBe(true);
    expect(new URL(logged, 'http://x.invalid').searchParams.get('hl')).toBe('en-US');
    expect(redactUrlEmail('/oidc/auth/private-uid?state=private-state')).toBe(
      '[authorization-url-redacted]',
    );
    expect(redactUrlEmail('/oidc/handoff?id=private-state&client=desktop')).not.toContain(
      'private',
    );
  });

  it('redacts interaction ids carried in the path', () => {
    for (const value of [
      'https://app.example.com/t/acme/oauth/consent/private-uid?hl=en-US',
      '/oidc/interaction/private-uid',
    ])
      expect(redactUrlEmail(value)).not.toContain('private');
    expect(redactUrlEmail('https://app.example.com/oauth/consent')).toContain('/oauth/consent');
  });

  it('redacts the remaining OIDC credentials carried in query strings', () => {
    const url = new URL('https://app.example.com/oidc/session/end');
    for (const key of [
      'id_token_hint',
      'client_secret',
      'client_assertion',
      'login_hint',
      'nonce',
      'user_code',
      'device_code',
    ])
      url.searchParams.set(key, 'private-' + key);
    expect(redactUrlEmail(url.href)).not.toContain('private');
  });
  it('does not log authorization URLs, including tenant-prefixed requests', () => {
    expect(
      redactUrlEmail(
        'https://app.example.com/t/acme/oidc/auth?client_id=lobehub-desktop&state=secret',
      ),
    ).toBe('[authorization-url-redacted]');
  });
});
