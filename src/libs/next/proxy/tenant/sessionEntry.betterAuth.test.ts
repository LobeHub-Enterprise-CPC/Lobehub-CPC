/**
 * @vitest-environment node
 */
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lookupEntrySession } from '@/server/services/tenantDiscovery/navigation';

/**
 * The session entry reads a REAL Better Auth instance (memory adapter, cookie cache off like the
 * enterprise delivery), because Better Auth 1.6.28 decodes `session_data` before it looks at
 * `disableCookieCache`: a mocked `getSession` cannot show that a damaged cache cookie blocks a
 * valid session. The cookie name comes from the instance's own `$context`, exactly as the proxy
 * reads it.
 */
const PREFIX = 'lh_entrytest';
const secret = 'isolated-entry-test-secret-0123456789-0123456789';

type Db = { account: unknown[]; session: unknown[]; user: unknown[]; verification: unknown[] };
const databases = new WeakMap<object, Db>();
const build = (cookieCache: boolean, lifetime?: { expiresIn: number; updateAge: number }) => {
  const db: Db = { account: [], session: [], user: [], verification: [] };
  const auth = betterAuth({
    // The tenant instance scopes its cookies to the organization path (src/auth.ts).
    advanced: { cookiePrefix: PREFIX, defaultCookieAttributes: { path: '/orgs/acme' } },
    baseURL: 'http://localhost:3010',
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    secret,
    session: {
      cookieCache: { enabled: cookieCache, maxAge: 1 },
      storeSessionInDatabase: true,
      ...lifetime,
    },
  });
  databases.set(auth, db);
  return auth;
};
const dbOf = (auth: Auth) => databases.get(auth)!;
type Auth = ReturnType<typeof build>;

const signUp = async (auth: Auth) => {
  const result = await auth.api.signUpEmail({
    body: { email: 'entry@example.invalid', name: 'Entry', password: 'entry-password-123456' },
    returnHeaders: true,
  });
  const pairs = result.headers.getSetCookie().map((cookie) => cookie.split(';')[0]);
  return {
    data: pairs.find((pair) => pair.includes('.session_data=')),
    token: pairs.find((pair) => pair.includes('.session_token='))!,
  };
};

/** The proxy's own lookup, against the real instance: the same function, the same cookie names. */
const entry = async (auth: Auth, cookie: string | undefined) => {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return lookupEntrySession(auth, headers);
};
const entryHasSession = async (auth: Auth, cookie: string | undefined) =>
  (await entry(auth, cookie)).hasSession;

/** Revoke server-side while the browser keeps its cookies. */
const revokeAll = (db: Db) => {
  db.session.length = 0;
};

afterEach(() => vi.useRealTimers());

describe.each([
  ['cookie cache off (enterprise)', false],
  ['cookie cache on (base distribution)', true],
])('session entry against real Better Auth, %s', (_name, cacheEnabled) => {
  it('reads the session cookie name from the instance, with the tenant prefix', async () => {
    const auth = build(cacheEnabled);
    const { authCookies } = await auth.$context;
    expect(authCookies.sessionData.name).toBe(`${PREFIX}.session_data`);
  });

  it('finds the session with only the token, and none without it', async () => {
    const auth = build(cacheEnabled);
    const { token } = await signUp(auth);
    expect(await entryHasSession(auth, token)).toBe(true);
    expect(await entryHasSession(auth, undefined)).toBe(false);
    expect(await entryHasSession(auth, `${PREFIX}.session_data=abc`)).toBe(false);
  });

  it.each([
    ['not base64', `${PREFIX}.session_data=%%%not-base64`],
    [
      'valid base64 but not JSON',
      `${PREFIX}.session_data=${Buffer.from('not json').toString('base64url')}`,
    ],
    ['oversized', `${PREFIX}.session_data=${'e'.repeat(6000)}`],
    ['chunked with garbage', `${PREFIX}.session_data.0=AAAA; ${PREFIX}.session_data.1=%%%`],
    ['secure-prefixed', `__Secure-${PREFIX}.session_data=%%%not-base64`],
  ])('still finds a valid session next to a damaged cache cookie (%s)', async (_label, damaged) => {
    const auth = build(cacheEnabled);
    const { token } = await signUp(auth);
    expect(await entryHasSession(auth, `${token}; ${damaged}`)).toBe(true);
  });

  it('still finds a valid session next to an expired cache cookie', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const auth = build(true);
    const { data, token } = await signUp(auth);
    expect(data).toBeDefined();
    vi.setSystemTime(Date.now() + 60_000);
    expect(await entryHasSession(auth, `${token}; ${data}`)).toBe(true);
  });

  it('does not count a cache cookie as a session when the token is invalid or revoked', async () => {
    const auth = build(true);
    const { data, token } = await signUp(auth);
    expect(await entryHasSession(auth, `${token}x; ${data}`)).toBe(false);
    expect(await entryHasSession(auth, data)).toBe(false);
    await auth.api.signOut({ headers: new Headers({ cookie: token }) });
    expect(await entryHasSession(auth, `${token}; ${data}`)).toBe(false);
  });
});

const names = (cookies: string[]) => cookies.map((cookie) => cookie.split('=')[0]).sort();
const deletion = (cookies: string[], name: string) =>
  cookies.find((cookie) => cookie.startsWith(`${name}=;`));

describe('session entry cleanup of hidden cache cookies, real Better Auth', () => {
  const chunks = `${PREFIX}.session_data.0=AAAA; ${PREFIX}.session_data.1=%%%`;

  it('deletes the token, the cache cookie and every hidden chunk, with the tenant path, for a revoked session', async () => {
    const auth = build(false);
    const { token } = await signUp(auth);
    revokeAll(dbOf(auth));
    const result = await entry(auth, `${token}; ${PREFIX}.session_data=junk; ${chunks}`);
    expect(result.hasSession).toBe(false);
    // Better Auth also clears its remember-me marker; the point is that nothing is left behind.
    expect(names(result.setCookies)).toEqual(
      expect.arrayContaining([
        `${PREFIX}.session_data`,
        `${PREFIX}.session_data.0`,
        `${PREFIX}.session_data.1`,
        `${PREFIX}.session_token`,
      ]),
    );
    for (const cookie of result.setCookies) {
      expect(cookie).toMatch(/Max-Age=0/);
      expect(cookie).toContain('Path=/orgs/acme');
      expect(cookie).toMatch(/^[^=]+=;/);
    }
  });

  it('deletes a damaged cache chunk set but never the token while the session is valid', async () => {
    const auth = build(false);
    const { token } = await signUp(auth);
    const result = await entry(auth, `${token}; ${chunks}`);
    expect(result.hasSession).toBe(true);
    expect(names(result.setCookies)).toEqual([
      `${PREFIX}.session_data.0`,
      `${PREFIX}.session_data.1`,
    ]);
    expect(deletion(result.setCookies, `${PREFIX}.session_token`)).toBeUndefined();
    for (const cookie of result.setCookies) expect(cookie).toContain('Path=/orgs/acme');
  });

  it("emits nothing for cookies it did not hide, and never touches another tenant's names", async () => {
    const auth = build(false);
    const { token } = await signUp(auth);
    const result = await entry(
      auth,
      `${token}; lh_other.session_data.0=keep; lh_other.session_token=keep`,
    );
    expect(result.hasSession).toBe(true);
    expect(result.setCookies).toEqual([]);
  });

  it('answers every name once, so it cannot override what Better Auth set for it', async () => {
    const auth = build(true);
    const { data, token } = await signUp(auth);
    const result = await entry(auth, `${token}; ${data}; ${chunks}`);
    expect(result.hasSession).toBe(true);
    const answered = names(result.setCookies);
    expect(new Set(answered).size).toBe(answered.length);
    expect(deletion(result.setCookies, `${PREFIX}.session_token`)).toBeUndefined();
  });

  it('secures the deletion of a secure-prefixed hidden cookie', async () => {
    const auth = build(false);
    const { token } = await signUp(auth);
    const result = await entry(auth, `${token}; __Secure-${PREFIX}.session_data.0=junk`);
    expect(result.setCookies).toEqual([
      expect.stringMatching(
        new RegExp(`^__Secure-${PREFIX}\\.session_data\\.0=; Max-Age=0; Path=/orgs/acme; .*Secure`),
      ),
    ]);
  });
});

describe.each([
  ['cookie cache off (enterprise)', false],
  ['cookie cache on (base distribution)', true],
])('session entry does not renew, real Better Auth, %s', (_name, cacheEnabled) => {
  // Lifetime 1h, renewal threshold 60s: past the threshold Better Auth's normal lookup extends the
  // session, so the entry's lack of renewal is a decision, not "not due yet".
  const lifetime = { expiresIn: 3600, updateAge: 60 };
  const AFTER_THRESHOLD = 120_000;

  const sessionRow = (auth: Auth) => {
    const [row] = dbOf(auth).session as { expiresAt: Date; token: string; updatedAt: Date }[];
    return { expiresAt: row.expiresAt.getTime(), updatedAt: row.updatedAt.getTime() };
  };

  /** A signed-in instance whose clock has moved past the renewal threshold but not past expiry. */
  const pastThreshold = async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const auth = build(cacheEnabled, lifetime);
    const { data, token } = await signUp(auth);
    const before = sessionRow(auth);
    vi.setSystemTime(Date.now() + AFTER_THRESHOLD);
    // Without a cache cookie in play, the lookup reads the persisted row either way.
    return { auth, before, cookie: cacheEnabled && data ? `${token}; ${data}` : token, token };
  };

  it('keeps expiresAt, updatedAt and the session token untouched past the renewal threshold', async () => {
    const { auth, before, cookie } = await pastThreshold();
    const result = await entry(auth, cookie);
    expect(result.hasSession).toBe(true);
    expect(sessionRow(auth)).toEqual(before);
    expect(deletion(result.setCookies, `${PREFIX}.session_token`)).toBeUndefined();
    expect(result.setCookies.some((line) => line.startsWith(`${PREFIX}.session_token=`))).toBe(
      false,
    );
  });

  it('control: the ordinary lookup at the same point does renew (threshold really reached)', async () => {
    const { auth, before, cookie } = await pastThreshold();
    const { headers, response } = await auth.api.getSession({
      headers: new Headers({ cookie }),
      returnHeaders: true,
    });
    expect(response?.user).toBeDefined();
    const after = sessionRow(auth);
    expect(after.expiresAt).toBeGreaterThanOrEqual(before.expiresAt + AFTER_THRESHOLD - 1000);
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
    expect(headers.getSetCookie().some((line) => line.startsWith(`${PREFIX}.session_token=`))).toBe(
      true,
    );
  });
});
