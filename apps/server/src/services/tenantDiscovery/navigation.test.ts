import { describe, expect, it } from 'vitest';

import {
  clearTenantCookie,
  expiredCookieHeaders,
  hideSessionDataCookies,
  isDocumentNavigation,
  isNonCanonicalSessionEntryPath,
  isSessionEntryPath,
  isValidTenantId,
  redactUrlEmail,
  serializeTenantCookie,
  SESSION_ENTRY_PATH,
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

describe('session entry path', () => {
  it('matches exactly the canonical path, and names the trailing-slash form separately', () => {
    expect(SESSION_ENTRY_PATH).toBe('/__entry');
    expect(isSessionEntryPath('/__entry')).toBe(true);
    for (const path of ['/__entry/', '/__entry//', '/__ENTRY', '/__entry/x', '/__entryx', '/', ''])
      expect(isSessionEntryPath(path)).toBe(false);
    expect(isNonCanonicalSessionEntryPath('/__entry/')).toBe(true);
    for (const path of ['/__entry', '/__entry//', '/__entry/x', '/agent/', '/'])
      expect(isNonCanonicalSessionEntryPath(path)).toBe(false);
  });
});

describe('hideSessionDataCookies', () => {
  const hide = (cookie: string | null, name = 'lh_x.session_data') => {
    const headers = new Headers({ 'x-keep': '1' });
    if (cookie !== null) headers.set('cookie', cookie);
    return hideSessionDataCookies(headers, name);
  };
  it('removes the cache cookie, its chunks and the secure-prefixed spelling only, and names them as sent', () => {
    const result = hide(
      'a=1; lh_x.session_data=z; lh_x.session_token=t; lh_x.session_data.0=z; __Secure-lh_x.session_data.1=z; b=2',
    );
    expect(result.headers.get('cookie')).toBe('a=1; lh_x.session_token=t; b=2');
    expect(result.removed).toEqual([
      'lh_x.session_data',
      'lh_x.session_data.0',
      '__Secure-lh_x.session_data.1',
    ]);
    const secure = hide('__Secure-lh_x.session_data=z; c=3', '__Secure-lh_x.session_data');
    expect(secure.headers.get('cookie')).toBe('c=3');
    expect(secure.removed).toEqual(['__Secure-lh_x.session_data']);
  });
  it('keeps lookalike and foreign cookies byte for byte, including empty values', () => {
    const cookie = 'lh_y.session_data=1; lh_x.session_dataX=2; lh_x.session_data_o=3; e=';
    const result = hide(cookie);
    expect(result.headers.get('cookie')).toBe(cookie);
    expect(result.removed).toEqual([]);
  });
  it('drops the header when nothing else remains and leaves a missing header and other headers alone', () => {
    expect(hide('lh_x.session_data=z').headers.has('cookie')).toBe(false);
    expect(hide(null).headers.has('cookie')).toBe(false);
    expect(hide(null).removed).toEqual([]);
    expect(hide('lh_x.session_data=z').headers.get('x-keep')).toBe('1');
  });
  it('does not mutate the request headers', () => {
    const headers = new Headers({ cookie: 'lh_x.session_data=z; a=1' });
    hideSessionDataCookies(headers, 'lh_x.session_data');
    expect(headers.get('cookie')).toBe('lh_x.session_data=z; a=1');
  });
});

describe('expiredCookieHeaders', () => {
  const attributes = { httpOnly: true, path: '/t/acme', sameSite: 'lax', secure: false };
  it('expires each name with the instance attributes, empty value and Max-Age=0', () => {
    expect(
      expiredCookieHeaders(['lh_x.session_data.0', 'lh_x.session_data.1'], [], attributes),
    ).toEqual([
      'lh_x.session_data.0=; Max-Age=0; Path=/t/acme; HttpOnly; SameSite=Lax',
      'lh_x.session_data.1=; Max-Age=0; Path=/t/acme; HttpOnly; SameSite=Lax',
    ]);
  });
  it('carries Domain, Secure and the other spellings of SameSite when configured', () => {
    expect(
      expiredCookieHeaders(['n'], [], {
        domain: 'example.com',
        httpOnly: true,
        path: '/',
        sameSite: 'none',
        secure: true,
      }),
    ).toEqual(['n=; Max-Age=0; Path=/; Domain=example.com; HttpOnly; Secure; SameSite=None']);
  });
  it('always secures a __Secure- cookie, whatever the instance attributes say', () => {
    expect(
      expiredCookieHeaders(['__Secure-n.0'], [], { path: '/t/acme', secure: false })[0],
    ).toContain('; Secure');
  });
  it('never overrides a cookie the response already sets or deletes, and does not repeat names', () => {
    expect(
      expiredCookieHeaders(
        ['a', 'b', 'a', 'c'],
        ['b=; Max-Age=0; Path=/t/acme', 'c=new; Path=/t/acme; Max-Age=60'],
        attributes,
      ),
    ).toEqual(['a=; Max-Age=0; Path=/t/acme; HttpOnly; SameSite=Lax']);
  });
});
