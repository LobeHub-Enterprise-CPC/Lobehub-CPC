/**
 * @vitest-environment node
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import Provider from 'oidc-provider';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInteractionPolicy } from './interaction-policy';
import { type InteractionLoginResult, loginInteractionResult } from './interactionLogin';

// Better Auth is the provider's external dependency: the tenant session the browser holds is
// whatever the test sets in `tenantUser`, read by the policy check through `getSession`.
const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('@/auth', () => ({
  getTenantAuth: async () => ({ api: { getSession: mocks.getSession } }),
}));

/**
 * The policy is exercised through a real oidc-provider (in-memory adapter, in-process HTTP
 * server): what matters is how the library evaluates the added check across the initial request
 * and the resume that follows an interaction, which a stub of `ctx` cannot show.
 *
 * The login step is answered by the real `loginInteractionResult` with the prompt reasons the
 * provider itself reported, exactly like the server login bridge does for a browser that holds a
 * tenant (Better Auth) session. The prompt-name guard of the routes is deliberately absent here:
 * what is under test is what the provider does with each result it is handed.
 */

const DESKTOP = 'tituwork-desktop';
const OTHER = 'lobehub-market';
const REDIRECT_URI = 'https://client.example/callback';

let server: Server;
let provider: Provider;
let origin: string;

const jar = new Map<string, string>();

/**
 * The tenant (Better Auth) session of the browser: the signed-in user id, `null` for no session,
 * or an error the session read throws.
 */
let tenantUser: Error | string | null;

/** Creation time of the tenant session the browser holds, in Unix seconds (the `auth_time`). */
let authTime: number;
/** The last login result the app handed to the provider, for replaying it. */
let lastLoginResult: InteractionLoginResult | undefined;
/** How many times the library asked the browser to end a provider session before a resume. */
let autoFormPosts = 0;

const request = async (url: string, form?: URLSearchParams) => {
  const response = await fetch(new URL(url, origin), {
    body: form,
    headers: {
      cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined),
    },
    method: form ? 'POST' : 'GET',
    redirect: 'manual',
  });
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
  return response;
};

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { ...privateKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig' };

  server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const publicWebClient = (client_id: string) => ({
    application_type: 'web' as const,
    client_id,
    grant_types: ['authorization_code'],
    redirect_uris: [REDIRECT_URI],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });

  provider = new Provider(origin, {
    clients: [publicWebClient(DESKTOP), publicWebClient(OTHER)],
    cookies: { keys: [randomBytes(16).toString('hex')] },
    features: { devInteractions: { enabled: false } },
    findAccount: async (_ctx, id) => ({ accountId: id, claims: async () => ({ sub: id }) }),
    interactions: {
      policy: createInteractionPolicy(),
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    jwks: { keys: [key as never] },
    pkce: { required: () => true },
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  jar.clear();
  authTime = Math.floor(Date.now() / 1000);
  lastLoginResult = undefined;
  autoFormPosts = 0;
  tenantUser = 'alice';
  mocks.getSession.mockReset();
  mocks.getSession.mockImplementation(async () => {
    if (tenantUser instanceof Error) throw tenantUser;
    if (tenantUser === null) return null;
    return {
      session: { createdAt: new Date(authTime * 1000) },
      user: { id: tenantUser },
    };
  });
});

/** Stands in for the app's interaction routes: report the prompt, or finish one step of it. */
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, origin);
  if (!url.pathname.startsWith('/interaction/')) return provider.callback()(req, res);

  try {
    const details = await provider.interactionDetails(req, res);
    const step = url.searchParams.get('step');
    let result;
    if (step === 'login') {
      lastLoginResult = loginInteractionResult(details.prompt.reasons, {
        ts: authTime,
        userId: typeof tenantUser === 'string' ? tenantUser : 'alice',
      });
      result = lastLoginResult;
    }
    // The same login result handed in again, whatever the interaction is by now.
    if (step === 'replay-login') result = lastLoginResult;
    if (step === 'consent') {
      const grant = new provider.Grant({
        accountId: details.session!.accountId as string,
        clientId: details.params.client_id!,
      });
      grant.addOIDCScope('openid');
      result = { consent: { grantId: await grant.save() } };
    }
    if (!result) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ prompt: details.prompt }));
      return;
    }
    const returnTo = await provider.interactionResult(req, res, result);
    res.statusCode = 303;
    res.setHeader('location', returnTo);
    res.end();
  } catch (error) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: (error as Error).name }));
  }
}

const authorize = (clientId: string, extra: Record<string, string> = {}) =>
  request(
    `/auth?${new URLSearchParams({
      client_id: clientId,
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
      ...extra,
    })}`,
  );

type Outcome =
  | { kind: 'interaction'; path: string; prompt: { name: string; reasons: string[] } }
  | { kind: 'redirect'; params: URLSearchParams };

/**
 * The auto-submitting form the library answers a resume with when the login result is for another
 * account than the provider session: it posts the end of that session. Returns the post's response.
 */
const submitAutoForm = async (response: Response) => {
  const html = await response.text();
  const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1];
  if (!action) throw new Error('no auto-submitting form');
  autoFormPosts += 1;
  const inputs = new URLSearchParams();
  for (const [, name, value] of html.matchAll(
    /<input type="hidden" name="([^"]+)" value="([^"]*)"/g,
  )) {
    inputs.set(name, value);
  }
  return request(new URL(action, origin).pathname, inputs);
};

/** Follow redirects until the flow stops at an interaction or leaves for the client. */
const settle = async (first: Response): Promise<Outcome> => {
  let response = first;
  for (let hops = 0; hops < 12; hops += 1) {
    if (response.status === 200 && (response.headers.get('content-type') ?? '').includes('html')) {
      response = await submitAutoForm(response);
    }
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!, origin);
    if (location.href.startsWith(REDIRECT_URI)) {
      return { kind: 'redirect', params: location.searchParams };
    }
    if (location.pathname.startsWith('/interaction/')) {
      const { prompt } = await (await request(location.pathname)).json();
      return { kind: 'interaction', path: location.pathname, prompt };
    }
    response = await request(location.pathname + location.search);
  }
  throw new Error('redirect loop');
};

const begin = async (clientId: string, extra?: Record<string, string>) =>
  settle(await authorize(clientId, extra));

const submit = async (outcome: Outcome, step: 'consent' | 'login' | 'replay-login') => {
  if (outcome.kind !== 'interaction') throw new Error('no interaction to submit');
  return settle(await request(`${outcome.path}?step=${step}`));
};

/** Sign in and consent, ending at the client redirect with the browser session kept. */
const signInAndConsent = async (clientId: string) => {
  const login = await begin(clientId);
  expect(login).toMatchObject({ kind: 'interaction', prompt: { name: 'login' } });
  const consent = await submit(login, 'login');
  expect(consent).toMatchObject({ kind: 'interaction', prompt: { name: 'consent' } });
  return submit(consent, 'consent');
};

describe('desktop_explicit_consent', () => {
  it('asks the desktop app for consent after login even without prompt=consent, then finishes', async () => {
    const login = await begin(DESKTOP);
    expect(login).toMatchObject({ kind: 'interaction', prompt: { name: 'login' } });

    const consent = await submit(login, 'login');
    expect(consent).toMatchObject({ kind: 'interaction', prompt: { name: 'consent' } });
    expect((consent as { prompt: { reasons: string[] } }).prompt.reasons).toContain(
      'desktop_explicit_consent',
    );

    // The resume after the consent card carries its result: no second card.
    const done = await submit(consent, 'consent');
    expect(done.kind).toBe('redirect');
    expect((done as { params: URLSearchParams }).params.get('code')).toBeTruthy();
  });

  it('still asks when the browser session and an earlier grant already cover the request', async () => {
    expect((await signInAndConsent(DESKTOP)).kind).toBe('redirect');

    const again = await begin(DESKTOP);

    expect(again).toMatchObject({
      kind: 'interaction',
      prompt: { name: 'consent', reasons: ['desktop_explicit_consent'] },
    });
    const done = await submit(again, 'consent');
    expect((done as { params: URLSearchParams }).params.get('code')).toBeTruthy();
  });

  it('answers prompt=none from the desktop app with consent_required', async () => {
    await signInAndConsent(DESKTOP);

    const silent = await begin(DESKTOP, { prompt: 'none' });

    expect(silent.kind).toBe('redirect');
    expect((silent as { params: URLSearchParams }).params.get('error')).toBe('consent_required');
  });

  it('leaves other clients silent once they are signed in and granted', async () => {
    const first = await begin(OTHER);
    const consent = await submit(first, 'login');
    expect(consent).toMatchObject({ kind: 'interaction', prompt: { name: 'consent' } });
    expect((consent as { prompt: { reasons: string[] } }).prompt.reasons).not.toContain(
      'desktop_explicit_consent',
    );
    expect((await submit(consent, 'consent')).kind).toBe('redirect');

    const again = await begin(OTHER);

    expect(again.kind).toBe('redirect');
    expect((again as { params: URLSearchParams }).params.get('code')).toBeTruthy();
  });
});

/** What the browser holds, to put back later and act as the browser did at that moment. */
const snapshotJar = () => new Map(jar);
const restoreJar = (snapshot: Map<string, string>) => {
  jar.clear();
  for (const [name, value] of snapshot) jar.set(name, value);
};

const paramsOf = (outcome: Outcome) => {
  if (outcome.kind !== 'redirect') throw new Error('the flow did not leave for the client');
  return outcome.params;
};

describe('login of a browser that holds a tenant session but no provider session', () => {
  it('ends a desktop prompt=login request with login_required, no code, and no provider session', async () => {
    const login = await begin(DESKTOP, { prompt: 'login' });
    expect(login).toMatchObject({ kind: 'interaction', prompt: { name: 'login' } });
    expect((login as { prompt: { reasons: string[] } }).prompt.reasons).toContain('login_prompt');

    const done = await submit(login, 'login');

    expect(paramsOf(done).get('error')).toBe('login_required');
    expect(paramsOf(done).get('code')).toBeNull();
    // Refusing signed nobody in: the next plain request starts from the same state.
    expect(await begin(DESKTOP)).toMatchObject({
      kind: 'interaction',
      prompt: { name: 'login', reasons: ['no_session'] },
    });
  });

  it('ends max_age=0 with login_required and no code', async () => {
    const login = await begin(DESKTOP, { max_age: '0' });
    expect(login).toMatchObject({ kind: 'interaction', prompt: { name: 'login' } });
    // The library folds max_age=0 into a forced re-login; whatever it reports, it is not just a
    // missing session.
    const { reasons } = (login as { prompt: { reasons: string[] } }).prompt;
    expect(reasons).not.toEqual(['no_session']);
    expect(reasons).toContain('login_prompt');

    const done = await submit(login, 'login');

    expect(paramsOf(done).get('error')).toBe('login_required');
    expect(paramsOf(done).get('code')).toBeNull();
  });

  it('does not treat a provider session older than a non-zero max_age as a plain missing session', async () => {
    // The session this browser got long ago: its auth_time is far in the past.
    authTime = Math.floor(Date.now() / 1000) - 3600;
    expect((await signInAndConsent(DESKTOP)).kind).toBe('redirect');
    expect(jar.size).toBeGreaterThan(0);

    const login = await begin(DESKTOP, { max_age: '60' });

    expect(login).toMatchObject({ kind: 'interaction', prompt: { name: 'login' } });
    const { reasons } = (login as { prompt: { reasons: string[] } }).prompt;
    expect(reasons).toEqual(['max_age']);
    expect(reasons).not.toContain('no_session');

    const done = await submit(login, 'login');

    expect(paramsOf(done).get('error')).toBe('login_required');
    expect(paramsOf(done).get('code')).toBeNull();
  });

  it('lets a session younger than max_age through without asking to log in again', async () => {
    expect((await signInAndConsent(DESKTOP)).kind).toBe('redirect');

    const again = await begin(DESKTOP, { max_age: '3600' });

    // Only the desktop explicit consent remains; no login prompt.
    expect(again).toMatchObject({ kind: 'interaction', prompt: { name: 'consent' } });
  });

  it('completes the login of an ordinary desktop request and moves on to consent', async () => {
    const login = await begin(DESKTOP);
    expect(login).toMatchObject({
      kind: 'interaction',
      prompt: { name: 'login', reasons: ['no_session'] },
    });

    const consent = await submit(login, 'login');

    expect(consent).toMatchObject({ kind: 'interaction', prompt: { name: 'consent' } });
    expect(lastLoginResult).toEqual({
      login: { accountId: 'alice', remember: true, ts: authTime },
    });
    const done = await submit(consent, 'consent');
    expect(paramsOf(done).get('code')).toBeTruthy();
  });

  describe('replay', () => {
    it('cannot finish consent by handing the login result in again once the prompt moved on', async () => {
      const login = await begin(DESKTOP);
      const atLogin = snapshotJar();
      const loginPath = (login as { path: string }).path;
      const consent = await submit(login, 'login');
      expect(consent).toMatchObject({ kind: 'interaction', prompt: { name: 'consent' } });

      // The old login interaction was spent by its own resume.
      const atConsent = snapshotJar();
      restoreJar(atLogin);
      const stale = await request(`${loginPath}?step=replay-login`);
      expect(stale.status).toBe(400);
      expect(await stale.json()).toEqual({ error: 'SessionNotFound' });

      // The login result submitted to the interaction that now waits for consent.
      restoreJar(atConsent);
      const replayed = await submit(consent, 'replay-login');
      expect(replayed).toMatchObject({ kind: 'interaction', prompt: { name: 'consent' } });
      expect(replayed.kind === 'redirect' ? replayed.params.get('code') : null).toBeNull();

      // The consent step still has to be taken, and then it is the only way to a code.
      const done = await submit(replayed, 'consent');
      expect(paramsOf(done).get('code')).toBeTruthy();
    });

    it('issues no second code when a finished interaction receives its results again', async () => {
      const consent = await submit(await begin(DESKTOP), 'login');
      expect(consent).toMatchObject({ kind: 'interaction', prompt: { name: 'consent' } });
      const consentPath = (consent as { path: string }).path;
      const loginResult = lastLoginResult;

      const submitted = await request(`${consentPath}?step=consent`);
      expect(submitted.status).toBe(303);
      const resumePath = submitted.headers.get('location')!;
      const beforeResume = snapshotJar();
      const done = await settle(submitted);
      expect(paramsOf(done).get('code')).toBeTruthy();

      // The browser comes back with what it held before the resume.
      restoreJar(beforeResume);
      const resumedAgain = await request(resumePath);
      expect(resumedAgain.headers.get('location') ?? '').not.toContain('code=');
      expect(resumedAgain.status).toBeGreaterThanOrEqual(400);

      for (const step of ['consent', 'replay-login'] as const) {
        restoreJar(beforeResume);
        lastLoginResult = loginResult;
        const again = await request(`${consentPath}?step=${step}`);
        expect(again.status).toBe(400);
        expect(await again.json()).toEqual({ error: 'SessionNotFound' });
      }
    });
  });
});

describe('tenant_session_mismatch', () => {
  const reasonsOf = (outcome: Outcome) =>
    (outcome as { prompt: { reasons: string[] } }).prompt.reasons;

  /** The browser signed in as alice and consented, so it now holds a provider session for her. */
  const withProviderSessionOfAlice = async (clientId = DESKTOP) => {
    expect((await signInAndConsent(clientId)).kind).toBe('redirect');
    expect(jar.size).toBeGreaterThan(0);
  };

  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    return { challenge: createHash('sha256').update(verifier).digest('base64url'), verifier };
  };

  const subOf = async (code: string, verifier: string) => {
    const response = await fetch(new URL('/token', origin), {
      body: new URLSearchParams({
        client_id: DESKTOP,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
      method: 'POST',
    });
    const { id_token: idToken } = await response.json();
    return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()).sub as string;
  };

  it('asks the desktop app to log in when its provider session outlived the tenant session', async () => {
    await withProviderSessionOfAlice();
    tenantUser = null;

    const again = await begin(DESKTOP);

    expect(again).toMatchObject({ kind: 'interaction', prompt: { name: 'login' } });
    expect(reasonsOf(again)).toEqual(['tenant_session_mismatch']);
  });

  it('reads the tenant session from the browser request, without refreshing it', async () => {
    await withProviderSessionOfAlice();
    mocks.getSession.mockClear();

    await begin(DESKTOP);

    expect(mocks.getSession).toHaveBeenCalled();
    const [{ headers, query }] = mocks.getSession.mock.calls[0];
    expect(query).toEqual({ disableRefresh: true });
    expect(headers.get('cookie')).toContain('_session=');
  });

  it('logs the desktop app in as the new account and issues its code when the tenant account changed', async () => {
    await withProviderSessionOfAlice();
    tenantUser = 'bob';
    const { challenge, verifier } = pkce();

    const login = await begin(DESKTOP, { code_challenge: challenge });
    expect(login).toMatchObject({ kind: 'interaction', prompt: { name: 'login' } });
    expect(reasonsOf(login)).toEqual(['tenant_session_mismatch']);

    // The login is completed for bob; the library ends alice's provider session first.
    const consent = await submit(login, 'login');
    expect(lastLoginResult).toEqual({ login: { accountId: 'bob', remember: true, ts: authTime } });
    expect(autoFormPosts).toBe(1);
    expect(consent).toMatchObject({ kind: 'interaction', prompt: { name: 'consent' } });

    const done = await submit(consent, 'consent');
    const code = paramsOf(done).get('code');
    expect(code).toBeTruthy();
    expect(await subOf(code!, verifier)).toBe('bob');

    // The provider session now belongs to bob: no further login while the tenant session holds.
    expect(await begin(DESKTOP)).toMatchObject({
      kind: 'interaction',
      prompt: { name: 'consent' },
    });
  });

  it('does not touch a provider session that matches the tenant session', async () => {
    await withProviderSessionOfAlice();

    const desktop = await begin(DESKTOP);
    expect(desktop).toMatchObject({
      kind: 'interaction',
      prompt: { name: 'consent', reasons: ['desktop_explicit_consent'] },
    });

    const other = await begin(OTHER);
    // Another client is not asked for consent only because the earlier grant was the desktop's.
    expect(other.kind === 'interaction' ? other.prompt.name : 'login').not.toBe('login');
  });

  it('asks to log in when the tenant session cannot be read', async () => {
    await withProviderSessionOfAlice();
    tenantUser = new Error('database unavailable');

    const again = await begin(DESKTOP);

    expect(again).toMatchObject({ kind: 'interaction', prompt: { name: 'login' } });
    expect(reasonsOf(again)).toEqual(['tenant_session_mismatch']);
  });

  it('asks a client other than the desktop app to log in as well', async () => {
    await withProviderSessionOfAlice(OTHER);
    tenantUser = null;

    const again = await begin(OTHER);

    expect(again).toMatchObject({ kind: 'interaction', prompt: { name: 'login' } });
    expect(reasonsOf(again)).toEqual(['tenant_session_mismatch']);
  });

  it('answers prompt=none with login_required', async () => {
    await withProviderSessionOfAlice();
    tenantUser = null;

    const silent = await begin(DESKTOP, { prompt: 'none' });

    expect(paramsOf(silent).get('error')).toBe('login_required');
    expect(paramsOf(silent).get('code')).toBeNull();
  });

  it('leaves a browser without a provider session to no_session and never reads the tenant session', async () => {
    const login = await begin(DESKTOP);

    expect(reasonsOf(login)).toEqual(['no_session']);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
});
