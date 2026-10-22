import crypto from 'node:crypto';

import type { DataSyncConfig } from '@lobechat/electron-client-ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AuthFlowHost,
  AuthFlowManager,
  MAX_AUTO_RESTARTS,
  PLATFORM_MAX_WAIT_MS,
} from '../AuthFlowManager';
import { createJwksResolver } from '../tokenVerifier';

const { logged, mockFetch } = vi.hoisted(() => ({
  logged: [] as string[],
  mockFetch: vi.fn(),
}));

vi.mock('@/utils/net-fetch', () => ({ netFetch: mockFetch }));
vi.mock('@/utils/user-agent', () => ({ setDesktopUserAgentHeader: vi.fn() }));
vi.mock('@/utils/http-headers', () => ({ appendVercelCookie: vi.fn() }));
vi.mock('@/utils/logger', () => {
  const record = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  return {
    createLogger: () => ({
      debug: record,
      error: record,
      info: record,
      verbose: record,
      warn: record,
    }),
  };
});

const PLATFORM = 'https://platform.example';
const ENTRY = `${PLATFORM}/t/acme`;
const ISSUER = `${ENTRY}/oidc`;
const T0 = Date.parse('2026-10-15T08:00:00Z');

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...init.headers },
    status: init.status ?? 200,
  });

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

interface World {
  /** What /oidc/handoff on a tenant returns next; the last entry repeats. */
  entryHandoff: Array<() => Response>;
  platformHandoff: Array<() => Response>;
  preflight: () => Response;
  tokenResponse: () => Response;
}

describe('AuthFlowManager', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', kid: 'k1', use: 'sig' };

  let world: World;
  let host: ReturnType<typeof makeHost>;
  let committed: DataSyncConfig['cloudTenant'];
  let manager: AuthFlowManager;
  let requests: Array<{ init: RequestInit; url: URL }>;
  let tokenClaims: { sub: string; tid: string };
  let idTokenOverride: string | undefined;
  let idTokenExtraClaims: Record<string, unknown>;

  const sign = (payload: Record<string, unknown>) => {
    const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = b64(payload);
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey);
    return `${head}.${body}.${signature.toString('base64url')}`;
  };

  const issueTokens = () => {
    const iat = Math.floor(Date.now() / 1000);
    const common = { exp: iat + 3600, iat, iss: ISSUER, sub: tokenClaims.sub };
    return jsonResponse({
      access_token: sign({ ...common, aud: 'urn:lobehub:chat', tid: tokenClaims.tid }),
      expires_in: 3600,
      id_token:
        idTokenOverride ??
        sign({
          ...common,
          aud: 'lobehub-desktop',
          email: 'alice@example.com',
          ...idTokenExtraClaims,
        }),
      refresh_token: 'refresh-secret-value',
    });
  };

  function makeHost() {
    return {
      afterCommit: vi.fn(),
      allowLoopbackHttp: false,
      broadcast: vi.fn(),
      commit: vi.fn(async (_params: Parameters<AuthFlowHost['commit']>[0]) => {}),
      getCommittedTenant: vi.fn(async () => committed),
      jwks: createJwksResolver(),
      openExternal: vi.fn(async () => {}),
      platformOrigin: () => PLATFORM,
    };
  }

  const next = (queue: Array<() => Response>) => (queue.length > 1 ? queue.shift()! : queue[0])();

  const snapshot = (overrides: Record<string, unknown> = {}) =>
    jsonResponse({
      endpointVersion: 3,
      entry: ENTRY,
      name: 'Acme Inc',
      tenantId: 'tenant-1',
      ...overrides,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    logged.length = 0;
    requests = [];
    committed = undefined;
    tokenClaims = { sub: 'user-1', tid: 'tenant-1' };
    idTokenOverride = undefined;
    idTokenExtraClaims = {};
    world = {
      entryHandoff: [() => new Response(null, { status: 404 })],
      platformHandoff: [() => jsonResponse({ code: 'HANDOFF_NOT_FOUND' }, { status: 404 })],
      preflight: () => jsonResponse({ issuer: ISSUER }),
      tokenResponse: issueTokens,
    };

    mockFetch.mockReset();
    mockFetch.mockImplementation(async (rawUrl: string, init: RequestInit = {}) => {
      const url = new URL(rawUrl);
      requests.push({ init, url });
      if (url.pathname === '/api/tenant-discovery/desktop-handoff')
        return next(world.platformHandoff);
      if (url.pathname === '/t/acme/oidc/handoff') return next(world.entryHandoff);
      if (url.pathname === '/t/acme/oidc/token') return world.tokenResponse();
      if (url.pathname === '/t/acme/oidc/jwks') return jsonResponse({ keys: [jwk] });
      if (url.pathname === '/t/acme/oidc/.well-known/openid-configuration')
        return world.preflight();
      return new Response(null, { status: 404 });
    });

    host = makeHost();
    manager = new AuthFlowManager(host);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  const openedUrl = (index = host.openExternal.mock.calls.length - 1) =>
    new URL((host.openExternal.mock.calls as unknown as string[][])[index][0]);
  const stateOf = (index?: number) => openedUrl(index).searchParams.get('state')!;

  const handoffReady = (state: string) => () =>
    jsonResponse({ data: { id: state, payload: { code: 'auth-code-123', state } }, success: true });

  const broadcasts = (channel: string) =>
    host.broadcast.mock.calls.filter(([name]) => name === channel).map(([, payload]) => payload);

  /** Drive a platform flow until the tenant stage is polling for a code. */
  const startPlatformFlow = async (config: DataSyncConfig = { storageMode: 'cloud' }) => {
    const result = await manager.start(config);
    expect(result).toEqual({ success: true });
    return stateOf();
  };

  const finishWithCode = async (state: string) => {
    world.entryHandoff = [handoffReady(state)];
    await vi.advanceTimersByTimeAsync(3100);
  };

  describe('platform flow', () => {
    it('opens the platform page with client=desktop, state and challenge, then binds the first snapshot', async () => {
      const state = await startPlatformFlow();
      const url = openedUrl();

      expect(url.origin + url.pathname).toBe(`${PLATFORM}/`);
      expect(url.searchParams.get('client')).toBe('desktop');
      expect(url.searchParams.get('state')).toMatch(/^[\da-f]{32}$/);
      expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
      expect(url.searchParams.has('switch')).toBe(false);

      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);

      const handoffPoll = requests.find(
        (r) => r.url.pathname === '/api/tenant-discovery/desktop-handoff',
      );
      expect(JSON.parse(handoffPoll!.init.body as string)).toEqual({
        codeChallenge: url.searchParams.get('code_challenge'),
        state,
      });
      expect(handoffPoll!.init.method).toBe('POST');
      // Moves on to the tenant stage against exactly the snapshot's entry.
      await vi.advanceTimersByTimeAsync(3100);
      expect(requests.some((r) => r.url.pathname === '/t/acme/oidc/handoff')).toBe(true);
    });

    it('always asks for confirmation and never commits or reconnects before it', async () => {
      committed = {
        display: { account: 'alice@example.com' },
        entryUrl: ENTRY,
        generation: 'old-generation',
        identity: { issuer: ISSUER, subject: 'user-1', tenantId: 'tenant-1' },
      };
      // Same entry, same account as the record, but reached through the platform handoff.
      const state = await startPlatformFlow({ remoteServerUrl: PLATFORM, storageMode: 'selfHost' });
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);

      expect(host.commit).not.toHaveBeenCalled();
      expect(host.afterCommit).not.toHaveBeenCalled();

      const [request] = broadcasts('authorizationConfirmRequired') as Array<
        Record<string, unknown>
      >;
      expect(request).toMatchObject({
        account: 'alice@example.com',
        entryUrl: ENTRY,
        name: 'Acme Inc',
      });
      expect(request.confirmationId).toEqual(expect.any(String));
      expect(JSON.stringify(request)).not.toContain('secret');
      expect(broadcasts('authorizationSuccessful')).toHaveLength(0);
    });

    it('commits exactly the verified identity once confirmed, then reconnects', async () => {
      const state = await startPlatformFlow();
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);

      const [request] = broadcasts('authorizationConfirmRequired') as Array<{
        confirmationId: string;
        generation: string;
      }>;
      const result = await manager.confirm({
        confirmationId: request.confirmationId,
        generation: request.generation,
      });

      expect(result).toEqual({ success: true });
      expect(host.commit).toHaveBeenCalledTimes(1);
      expect(host.commit).toHaveBeenCalledWith({
        display: { account: 'alice@example.com', organizationName: 'Acme Inc' },
        entryUrl: ENTRY,
        generation: request.generation,
        identity: { issuer: ISSUER, subject: 'user-1', tenantId: 'tenant-1' },
        remoteServerUrl: undefined,
        storageMode: 'cloud',
        tokens: expect.objectContaining({ refreshToken: 'refresh-secret-value' }),
      });
      expect(host.commit.mock.invocationCallOrder[0]).toBeLessThan(
        host.afterCommit.mock.invocationCallOrder[0],
      );
      expect(broadcasts('authorizationSuccessful')).toHaveLength(1);
    });

    describe('organization display claims of the id_token', () => {
      const confirmWith = async (claims: Record<string, unknown>, snapshotName = 'Acme Inc') => {
        idTokenExtraClaims = claims;
        const state = await startPlatformFlow();
        world.platformHandoff = [() => snapshot({ name: snapshotName })];
        await vi.advanceTimersByTimeAsync(10);
        await finishWithCode(state);
        const [request] = broadcasts('authorizationConfirmRequired') as Array<
          Record<string, unknown> & { confirmationId: string; generation: string }
        >;
        return request;
      };

      it('shows tenant_name, tenant_slug and has_other_organizations on the card and commits them', async () => {
        const request = await confirmWith({
          has_other_organizations: false,
          tenant_name: 'Acme From Token',
          tenant_slug: 'acme',
        });

        expect(request).toMatchObject({
          hasOtherOrganizations: false,
          name: 'Acme From Token',
          slug: 'acme',
        });
        await manager.confirm(request);
        expect(host.commit.mock.calls[0][0].display).toEqual({
          account: 'alice@example.com',
          hasOtherOrganizations: false,
          organizationName: 'Acme From Token',
          organizationSlug: 'acme',
        });
      });

      it('falls back to the handoff snapshot name when tenant_name is missing', async () => {
        const request = await confirmWith({ tenant_slug: 'acme' });

        expect(request).toMatchObject({ name: 'Acme Inc', slug: 'acme' });
        expect(request).not.toHaveProperty('hasOtherOrganizations');
      });

      it('treats invalid claims as missing without failing the login', async () => {
        const request = await confirmWith({
          has_other_organizations: 'yes',
          tenant_name: '',
          tenant_slug: 'Not A Slug',
        });

        expect(request).toMatchObject({ name: 'Acme Inc' });
        expect(request).not.toHaveProperty('slug');
        expect(request).not.toHaveProperty('hasOtherOrganizations');
        expect(broadcasts('authorizationFailed')).toHaveLength(0);
        await manager.confirm(request);
        expect(host.commit.mock.calls[0][0].display).toEqual({
          account: 'alice@example.com',
          organizationName: 'Acme Inc',
        });
      });
    });

    it('rejects a second confirmation, a wrong id and a wrong generation', async () => {
      const state = await startPlatformFlow();
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);
      const [request] = broadcasts('authorizationConfirmRequired') as Array<{
        confirmationId: string;
        generation: string;
      }>;

      expect(await manager.confirm({ ...request, confirmationId: 'other' })).toMatchObject({
        code: 'CONFIRMATION_INVALID',
      });
      expect(await manager.confirm({ ...request, generation: 'other' })).toMatchObject({
        code: 'CONFIRMATION_INVALID',
      });
      expect(host.commit).not.toHaveBeenCalled();

      expect(await manager.confirm(request)).toEqual({ success: true });
      expect(await manager.confirm(request)).toMatchObject({ code: 'CONFIRMATION_INVALID' });
      expect(host.commit).toHaveBeenCalledTimes(1);
    });

    it('discards the pending login after 5 minutes without an answer', async () => {
      const state = await startPlatformFlow();
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);
      const [request] = broadcasts('authorizationConfirmRequired') as Array<{
        confirmationId: string;
        generation: string;
      }>;

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

      expect(broadcasts('authorizationConfirmDismissed')).toContainEqual({
        confirmationId: request.confirmationId,
        reason: 'expired',
      });
      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'CONFIRMATION_TIMEOUT' }),
      );
      expect(await manager.confirm(request)).toMatchObject({ code: 'CONFIRMATION_INVALID' });
      expect(host.commit).not.toHaveBeenCalled();
    });

    it('cancelling the confirmation discards the pending tokens', async () => {
      const state = await startPlatformFlow();
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);
      const [request] = broadcasts('authorizationConfirmRequired') as Array<{
        confirmationId: string;
        generation: string;
      }>;

      expect(manager.cancelConfirmation(request)).toEqual({ success: true });
      expect(manager.getPendingRequest()).toBeNull();
      expect(await manager.confirm(request)).toMatchObject({ code: 'CONFIRMATION_INVALID' });
      expect(host.commit).not.toHaveBeenCalled();
    });

    it('"switch organization" on the card drops the pending login and restarts with switch=1', async () => {
      const state = await startPlatformFlow();
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);
      const [request] = broadcasts('authorizationConfirmRequired') as Array<{
        confirmationId: string;
        generation: string;
      }>;

      const result = await manager.switchFromConfirmation(request);

      expect(result).toEqual({ success: true });
      const url = openedUrl();
      expect(url.searchParams.get('switch')).toBe('1');
      expect(url.searchParams.get('state')).not.toBe(state);
      expect(host.commit).not.toHaveBeenCalled();
    });

    it('fails closed when the access token tenant differs from the selected organization', async () => {
      tokenClaims = { sub: 'user-1', tid: 'tenant-2' };
      const state = await startPlatformFlow();
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);

      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'IDENTITY_VERIFICATION_FAILED' }),
      );
      expect(broadcasts('authorizationConfirmRequired')).toHaveLength(0);
      expect(host.commit).not.toHaveBeenCalled();
    });

    it('fails closed without an id_token, and on an id_token for another audience', async () => {
      world.tokenResponse = () =>
        jsonResponse({ access_token: 'a', expires_in: 1, refresh_token: 'r' });
      let state = await startPlatformFlow();
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);
      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'TOKEN_EXCHANGE_FAILED' }),
      );

      host.broadcast.mockClear();
      world.entryHandoff = [() => new Response(null, { status: 404 })];
      world.tokenResponse = issueTokens;
      idTokenOverride = sign({
        aud: 'someone-else',
        exp: Math.floor(Date.now() / 1000) + 600,
        iat: Math.floor(Date.now() / 1000),
        iss: ISSUER,
        sub: 'user-1',
      });
      state = await startPlatformFlow();
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);
      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'IDENTITY_VERIFICATION_FAILED' }),
      );
      expect(host.commit).not.toHaveBeenCalled();
    });

    it('stops waiting for the organization after 10 minutes', async () => {
      await startPlatformFlow();

      await vi.advanceTimersByTimeAsync(PLATFORM_MAX_WAIT_MS + 4000);

      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'AUTHORIZATION_TIMEOUT' }),
      );
    });

    it('honours Retry-After on 429 and rejects a 400 with a fixed code', async () => {
      await startPlatformFlow();
      const polls = () =>
        requests.filter((r) => r.url.pathname === '/api/tenant-discovery/desktop-handoff').length;
      world.platformHandoff = [
        () => new Response(null, { headers: { 'Retry-After': '20' }, status: 429 }),
      ];
      await vi.advanceTimersByTimeAsync(3100);
      world.platformHandoff = [() => jsonResponse({ code: 'HANDOFF_NOT_FOUND' }, { status: 404 })];
      const before = polls();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(polls()).toBe(before);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(polls()).toBeGreaterThan(before);

      world.platformHandoff = [() => new Response(null, { status: 400 })];
      await vi.advanceTimersByTimeAsync(4000);
      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'PLATFORM_HANDOFF_REJECTED' }),
      );
    });

    it('backs off on 503 and gives up after five consecutive failures', async () => {
      world.platformHandoff = [() => new Response(null, { status: 503 })];
      await startPlatformFlow();
      const polls = () =>
        requests.filter((r) => r.url.pathname === '/api/tenant-discovery/desktop-handoff').length;

      await vi.advanceTimersByTimeAsync(3000);
      expect(polls()).toBeLessThan(4);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(polls()).toBe(5);
      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'PLATFORM_UNAVAILABLE' }),
      );
    });

    it('treats a snapshot with a non-https entry as inconsistent', async () => {
      world.platformHandoff = [() => snapshot({ entry: 'http://evil.example/t/acme' })];
      await startPlatformFlow();
      await vi.advanceTimersByTimeAsync(10);

      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'HANDOFF_INCONSISTENT' }),
      );
    });

    it.each([
      ['a name longer than the server allows', { name: 'x'.repeat(4097) }],
      ['an empty name', { name: '' }],
      ['a missing name', { name: undefined }],
      ['a string endpointVersion', { endpointVersion: '3' }],
      ['a fractional endpointVersion', { endpointVersion: 1.5 }],
      ['a zero endpointVersion', { endpointVersion: 0 }],
      ['a tenantId the server would never issue', { tenantId: 'bad id/with space' }],
      ['an entry longer than the server allows', { entry: `${PLATFORM}/t/${'a'.repeat(2048)}` }],
    ])('treats a snapshot with %s as unusable', async (_name, overrides) => {
      world.platformHandoff = [() => snapshot(overrides)];
      await startPlatformFlow();
      await vi.advanceTimersByTimeAsync(10);

      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'HANDOFF_INCONSISTENT' }),
      );
    });

    it('accepts a name up to the server limit', async () => {
      world.platformHandoff = [() => snapshot({ name: 'x'.repeat(4096) })];
      await startPlatformFlow();
      await vi.advanceTimersByTimeAsync(10);

      expect(broadcasts('authorizationFailed')).toHaveLength(0);
    });

    it('a new flow invalidates the old one for good, including its late responses', async () => {
      const oldState = await startPlatformFlow();
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);

      await manager.startPlatform({ switchOrganization: true });
      const newState = stateOf();
      expect(newState).not.toBe(oldState);

      // The old state's code arriving now must not produce a login.
      world.entryHandoff = [handoffReady(oldState)];
      await vi.advanceTimersByTimeAsync(10_000);

      expect(broadcasts('authorizationConfirmRequired')).toHaveLength(0);
      expect(host.commit).not.toHaveBeenCalled();
    });
  });

  describe('an unconfirmed attempt leaves the committed session alone', () => {
    beforeEach(() => {
      committed = {
        display: { account: 'alice@example.com', organizationName: 'Acme Inc' },
        entryUrl: ENTRY,
        generation: 'generation-a',
        identity: { issuer: ISSUER, subject: 'user-1', tenantId: 'tenant-1' },
      };
      // The attempt targets another organization of the same platform.
      tokenClaims = { sub: 'user-2', tid: 'tenant-1' };
    });

    const reachConfirmation = async () => {
      expect(await manager.startPlatform({ switchOrganization: true })).toEqual({ success: true });
      const state = stateOf();
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);
      const [request] = broadcasts('authorizationConfirmRequired') as Array<{
        confirmationId: string;
        generation: string;
      }>;
      expect(request).toBeDefined();
      return request;
    };

    const expectUntouched = () => {
      expect(host.commit).not.toHaveBeenCalled();
      expect(host.afterCommit).not.toHaveBeenCalled();
      expect(broadcasts('authorizationSuccessful')).toHaveLength(0);
    };

    it('while the organization is still being chosen, including when that is cancelled', async () => {
      await manager.startPlatform({ switchOrganization: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(manager.cancel()).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);

      expectUntouched();
    });

    it('when the platform selection times out', async () => {
      await manager.startPlatform({ switchOrganization: true });
      await vi.advanceTimersByTimeAsync(PLATFORM_MAX_WAIT_MS + 10_000);

      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'AUTHORIZATION_TIMEOUT' }),
      );
      expectUntouched();
    });

    it('when the identity check fails after the user logged in', async () => {
      idTokenOverride = 'not-a-jwt';
      await manager.startPlatform({ switchOrganization: true });
      const state = stateOf();
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);

      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'IDENTITY_VERIFICATION_FAILED' }),
      );
      expectUntouched();
    });

    it('when the confirmation card is cancelled', async () => {
      const request = await reachConfirmation();
      expect(manager.cancelConfirmation(request)).toEqual({ success: true });

      expectUntouched();
    });

    it('when the confirmation card times out', async () => {
      await reachConfirmation();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'CONFIRMATION_TIMEOUT' }),
      );
      expectUntouched();
    });

    it('and only the confirmation replaces it, with the new identity', async () => {
      const request = await reachConfirmation();
      expectUntouched();

      expect(await manager.confirm(request)).toEqual({ success: true });

      expect(host.commit).toHaveBeenCalledTimes(1);
      expect(host.commit.mock.calls[0][0].identity).toEqual({
        issuer: ISSUER,
        subject: 'user-2',
        tenantId: 'tenant-1',
      });
      expect(host.afterCommit).toHaveBeenCalledTimes(1);
    });
  });

  describe('known-entry flow', () => {
    const selfHost: DataSyncConfig = { remoteServerUrl: `${ENTRY}/`, storageMode: 'selfHost' };

    it('preflights the issuer, then goes straight to the tenant with the full scope and no platform handoff', async () => {
      const result = await manager.start(selfHost);

      expect(result).toEqual({ success: true });
      const url = openedUrl();
      expect(url.origin + url.pathname).toBe(`${ENTRY}/oidc/auth`);
      expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
      expect(url.searchParams.get('redirect_uri')).toBe(`${ENTRY}/oidc/callback/desktop`);
      expect(url.searchParams.get('client_id')).toBe('lobehub-desktop');
      expect(requests[0].url.pathname).toBe('/t/acme/oidc/.well-known/openid-configuration');

      await vi.advanceTimersByTimeAsync(5000);
      expect(requests.some((r) => r.url.pathname === '/api/tenant-discovery/desktop-handoff')).toBe(
        false,
      );
    });

    it('fails closed, without opening the browser, when the issuer does not match', async () => {
      world.preflight = () => jsonResponse({ issuer: 'https://other.example/oidc' });

      expect(await manager.start(selfHost)).toMatchObject({
        code: 'INVALID_ORGANIZATION_ADDRESS',
        success: false,
      });
      expect(host.openExternal).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-200 answer', () => new Response('nope', { status: 400 })],
      [
        'a redirect (never followed)',
        () => {
          throw new TypeError('redirect mode is set to error');
        },
      ],
    ])('rejects the address on %s', async (_name, preflight) => {
      world.preflight = preflight as () => Response;

      expect(await manager.start(selfHost)).toMatchObject({ code: 'INVALID_ORGANIZATION_ADDRESS' });
      expect(host.openExternal).not.toHaveBeenCalled();
    });

    it('rejects addresses that are not https', async () => {
      expect(
        await manager.start({
          remoteServerUrl: 'http://platform.example/t/acme',
          storageMode: 'selfHost',
        }),
      ).toMatchObject({ code: 'INVALID_SERVER_ADDRESS' });
      expect(
        await manager.start({
          remoteServerUrl: 'https://u:p@platform.example/t/acme',
          storageMode: 'selfHost',
        }),
      ).toMatchObject({ code: 'INVALID_SERVER_ADDRESS' });
    });

    it('treats the bare platform origin as the platform flow, and a bad path as invalid', async () => {
      expect(await manager.start({ remoteServerUrl: PLATFORM, storageMode: 'selfHost' })).toEqual({
        success: true,
      });
      expect(openedUrl().searchParams.get('client')).toBe('desktop');

      expect(
        await manager.start({ remoteServerUrl: `${PLATFORM}/somewhere`, storageMode: 'selfHost' }),
      ).toMatchObject({ code: 'INVALID_ORGANIZATION_ADDRESS' });
    });

    const completeKnownEntry = async () => {
      expect(await manager.start(selfHost)).toEqual({ success: true });
      await finishWithCode(stateOf());
    };

    it('skips the confirmation only for the exact previously confirmed iss, tenant, subject and entry', async () => {
      committed = {
        display: { account: 'alice@example.com' },
        entryUrl: ENTRY,
        generation: 'old-generation',
        identity: { issuer: ISSUER, subject: 'user-1', tenantId: 'tenant-1' },
      };

      await completeKnownEntry();

      expect(broadcasts('authorizationConfirmRequired')).toHaveLength(0);
      expect(host.commit).toHaveBeenCalledTimes(1);
      expect(host.commit.mock.calls[0][0]).toMatchObject({
        display: { account: 'alice@example.com' },
        remoteServerUrl: ENTRY,
        storageMode: 'selfHost',
      });
      expect(host.commit.mock.calls[0][0].display).not.toHaveProperty('organizationName');
    });

    it('carries the claims into the commit of a skipped-confirmation re-login', async () => {
      committed = {
        display: { account: 'alice@example.com' },
        entryUrl: ENTRY,
        generation: 'old-generation',
        identity: { issuer: ISSUER, subject: 'user-1', tenantId: 'tenant-1' },
      };
      idTokenExtraClaims = {
        has_other_organizations: true,
        tenant_name: 'Acme',
        tenant_slug: 'acme',
      };

      await completeKnownEntry();

      expect(broadcasts('authorizationConfirmRequired')).toHaveLength(0);
      expect(host.commit.mock.calls[0][0].display).toEqual({
        account: 'alice@example.com',
        hasOtherOrganizations: true,
        organizationName: 'Acme',
        organizationSlug: 'acme',
      });
    });

    it.each([
      [
        'a different account',
        { identity: { issuer: ISSUER, subject: 'user-2', tenantId: 'tenant-1' } },
      ],
      [
        'a different tenant',
        { identity: { issuer: ISSUER, subject: 'user-1', tenantId: 'tenant-9' } },
      ],
      [
        'a different issuer',
        { identity: { issuer: 'https://x.example/oidc', subject: 'user-1', tenantId: 'tenant-1' } },
      ],
      ['a different entry', { entryUrl: 'https://platform.example/t/other' }],
      ['no previous record', undefined],
    ])('asks for confirmation for %s', async (_name, override) => {
      committed = override
        ? {
            display: { account: 'alice@example.com' },
            entryUrl: ENTRY,
            generation: 'old-generation',
            identity: { issuer: ISSUER, subject: 'user-1', tenantId: 'tenant-1' },
            ...override,
          }
        : undefined;

      await completeKnownEntry();

      expect(host.commit).not.toHaveBeenCalled();
      const [request] = broadcasts('authorizationConfirmRequired') as Array<
        Record<string, unknown>
      >;
      expect(request).toMatchObject({ account: 'alice@example.com', entryUrl: ENTRY });
      // Known-entry logins show the address, not an organization name.
      expect(request).not.toHaveProperty('name');
    });

    it('uses the confirmed record of a cloud config as a known entry, expecting its tenant', async () => {
      committed = {
        display: { account: 'alice@example.com' },
        entryUrl: ENTRY,
        generation: 'old-generation',
        identity: { issuer: ISSUER, subject: 'user-1', tenantId: 'tenant-1' },
      };

      await manager.start({ storageMode: 'cloud' });

      expect(openedUrl().pathname).toBe('/t/acme/oidc/auth');
      expect(requests.some((r) => r.url.pathname.includes('desktop-handoff'))).toBe(false);
    });

    it('displays the subject when the id token has no email or preferred_username', async () => {
      const iat = Math.floor(Date.now() / 1000);
      idTokenOverride = sign({
        aud: 'lobehub-desktop',
        exp: iat + 600,
        iat,
        iss: ISSUER,
        sub: 'user-1',
      });

      await completeKnownEntry();

      expect(broadcasts('authorizationConfirmRequired')).toContainEqual(
        expect.objectContaining({ account: 'user-1' }),
      );
    });
  });

  describe('409 TENANT_ENDPOINT_CHANGED', () => {
    const changed = () =>
      jsonResponse(
        { activeUrl: 'https://elsewhere.example/t/acme', code: 'TENANT_ENDPOINT_CHANGED' },
        { status: 409 },
      );

    it('restarts through the platform with fresh state and the same expected tenant, never using the 409 address', async () => {
      const state = await startPlatformFlow();
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      world.entryHandoff = [changed, () => new Response(null, { status: 404 })];
      await vi.advanceTimersByTimeAsync(3100);

      expect(broadcasts('authorizationRestarting')).toEqual([{ attempt: 1, maxAttempts: 2 }]);
      expect(host.openExternal).toHaveBeenCalledTimes(2);
      const restartUrl = openedUrl();
      expect(restartUrl.origin).toBe(PLATFORM);
      expect(restartUrl.searchParams.get('state')).not.toBe(state);
      expect(restartUrl.searchParams.has('switch')).toBe(false);
      expect(requests.every((r) => r.url.origin === PLATFORM)).toBe(true);
    });

    it('stops automatic recovery when the new snapshot names another organization', async () => {
      await startPlatformFlow();
      world.platformHandoff = [() => snapshot(), () => snapshot({ tenantId: 'tenant-2' })];
      await vi.advanceTimersByTimeAsync(10);
      world.entryHandoff = [changed, () => new Response(null, { status: 404 })];
      await vi.advanceTimersByTimeAsync(3100);

      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'ORGANIZATION_CHANGED_SWITCH_REQUIRED' }),
      );
    });

    it('restarts at most twice per login attempt', async () => {
      world.entryHandoff = [changed];
      world.platformHandoff = [() => snapshot()];
      await startPlatformFlow();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(broadcasts('authorizationRestarting')).toHaveLength(MAX_AUTO_RESTARTS);
      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'ENDPOINT_CHANGED_RESTART_LIMIT' }),
      );
    });

    it('on a standalone self-hosted server asks to update the address instead of using the platform', async () => {
      mockFetch.mockImplementation(async (rawUrl: string) => {
        const url = new URL(rawUrl);
        if (url.pathname.endsWith('/.well-known/openid-configuration')) return changed();
        return new Response(null, { status: 404 });
      });
      expect(
        await manager.start({
          remoteServerUrl: 'https://self-host.example',
          storageMode: 'selfHost',
        }),
      ).toMatchObject({ code: 'ENDPOINT_CHANGED_UPDATE_ADDRESS' });
      expect(host.openExternal).not.toHaveBeenCalled();
    });

    it('recovers a known-entry login through the platform, keeping the committed tenant', async () => {
      committed = {
        display: { account: 'alice@example.com' },
        entryUrl: ENTRY,
        generation: 'old-generation',
        identity: { issuer: ISSUER, subject: 'user-1', tenantId: 'tenant-1' },
      };
      world.preflight = changed;

      expect(await manager.start({ storageMode: 'cloud' })).toEqual({ success: true });

      expect(openedUrl().origin + openedUrl().pathname).toBe(`${PLATFORM}/`);
      expect(openedUrl().searchParams.get('client')).toBe('desktop');
      expect(broadcasts('authorizationRestarting')).toHaveLength(1);
    });
  });

  describe('forced discovery and commit failure', () => {
    const record = {
      display: { account: 'alice@example.com' },
      entryUrl: ENTRY,
      generation: 'old-generation',
      identity: { issuer: ISSUER, subject: 'user-1', tenantId: 'tenant-1' },
    };

    it('forceDiscovery skips the committed entry and keeps its tenant as the expectation', async () => {
      committed = record;

      await manager.start({ storageMode: 'cloud' }, { forceDiscovery: true });

      expect(openedUrl().origin + openedUrl().pathname).toBe(`${PLATFORM}/`);
      expect(requests.some((r) => r.url.pathname.startsWith('/t/acme/'))).toBe(false);

      world.platformHandoff = [() => snapshot({ tenantId: 'tenant-other' })];
      await vi.advanceTimersByTimeAsync(3100);

      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'ORGANIZATION_CHANGED_SWITCH_REQUIRED' }),
      );
    });

    it('a failed commit ends the flow without activating anything', async () => {
      const state = await startPlatformFlow();
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);
      const [request] = broadcasts('authorizationConfirmRequired') as Array<{
        confirmationId: string;
        generation: string;
      }>;
      host.commit.mockRejectedValueOnce(new Error('disk full'));

      expect(await manager.confirm(request)).toMatchObject({
        code: 'COMMIT_FAILED',
        success: false,
      });

      expect(host.afterCommit).not.toHaveBeenCalled();
      expect(broadcasts('authorizationSuccessful')).toHaveLength(0);
      expect(manager.hasActiveFlow()).toBe(false);
      // Consumed, not retryable: the same confirmation is now invalid and the card is closed.
      expect(await manager.confirm(request)).toMatchObject({ code: 'CONFIRMATION_INVALID' });
      expect(broadcasts('authorizationConfirmDismissed')).toContainEqual({
        confirmationId: request.confirmationId,
        reason: 'cancelled',
      });
    });
  });

  describe('handoff 404 / 400 bodies', () => {
    const notFound = (body?: unknown) => () =>
      body === undefined
        ? new Response(null, { status: 404 })
        : jsonResponse(body, { status: 404 });
    const polls = (path: string) => requests.filter((r) => r.url.pathname === path).length;

    it('keeps polling the platform on 404 HANDOFF_NOT_FOUND', async () => {
      world.platformHandoff = [notFound({ code: 'HANDOFF_NOT_FOUND' })];
      await startPlatformFlow();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(polls('/api/tenant-discovery/desktop-handoff')).toBeGreaterThan(2);
      expect(broadcasts('authorizationFailed')).toHaveLength(0);
    });

    it.each([
      ['a coded NOT_FOUND (host not served)', () => notFound({ code: 'NOT_FOUND' })()],
      ['a 404 without any body', () => notFound()()],
      [
        'a non-JSON 404 page',
        () =>
          new Response('<html>Not Found</html>', {
            headers: { 'content-type': 'text/html' },
            status: 404,
          }),
      ],
      ['a JSON 404 without a code', () => notFound({ error: 'nope' })()],
      ['a 404 with another code', () => notFound({ code: 'TENANT_NOT_AVAILABLE' })()],
    ])('fails at once, without more polling, on %s', async (_name, response) => {
      world.platformHandoff = [response];
      await startPlatformFlow();
      await vi.advanceTimersByTimeAsync(10);

      expect(broadcasts('authorizationFailed')).toContainEqual(
        expect.objectContaining({ code: 'PLATFORM_MISCONFIGURED' }),
      );
      const count = polls('/api/tenant-discovery/desktop-handoff');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(polls('/api/tenant-discovery/desktop-handoff')).toBe(count);
    });

    it('only a tenant 404 without a code means "keep waiting"', async () => {
      world.platformHandoff = [() => snapshot()];
      await startPlatformFlow();
      world.entryHandoff = [notFound({ error: 'Handoff record not found or expired' })];
      await vi.advanceTimersByTimeAsync(10_000);

      expect(polls('/t/acme/oidc/handoff')).toBeGreaterThan(2);
      expect(broadcasts('authorizationFailed')).toHaveLength(0);
    });

    it.each([
      ['404 NOT_FOUND', () => notFound({ code: 'NOT_FOUND' })(), 'INVALID_ORGANIZATION_ADDRESS'],
      [
        '400 TENANT_REQUIRED',
        () => jsonResponse({ code: 'TENANT_REQUIRED' }, { status: 400 }),
        'INVALID_ORGANIZATION_ADDRESS',
      ],
      [
        '400 TENANT_INVALID',
        () => jsonResponse({ code: 'TENANT_INVALID' }, { status: 400 }),
        'INVALID_ORGANIZATION_ADDRESS',
      ],
      [
        '400 missing params',
        () => jsonResponse({ error: 'missing id' }, { status: 400 }),
        'HANDOFF_INCONSISTENT',
      ],
    ])('fails at once on a tenant %s', async (_name, response, code) => {
      world.platformHandoff = [() => snapshot()];
      await startPlatformFlow();
      world.entryHandoff = [response as () => Response];
      await vi.advanceTimersByTimeAsync(3100);

      expect(broadcasts('authorizationFailed')).toContainEqual(expect.objectContaining({ code }));
      const count = polls('/t/acme/oidc/handoff');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(polls('/t/acme/oidc/handoff')).toBe(count);
    });
  });

  describe('redirects and logging', () => {
    it('never follows redirects on handoff, preflight, token or jwks requests', async () => {
      const state = await startPlatformFlow();
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);

      expect(requests.length).toBeGreaterThanOrEqual(4);
      expect(requests.every((r) => r.init.redirect === 'error')).toBe(true);
    });

    it('keeps state, challenge, code, verifier, tokens and URLs out of the logs', async () => {
      const state = await startPlatformFlow();
      const challenge = openedUrl().searchParams.get('code_challenge')!;
      world.platformHandoff = [() => snapshot()];
      await vi.advanceTimersByTimeAsync(10);
      await finishWithCode(state);

      const tokenRequest = requests.find((r) => r.url.pathname === '/t/acme/oidc/token')!;
      const verifier = new URLSearchParams(tokenRequest.init.body as string).get('code_verifier')!;
      const output = logged.join('\n');

      expect(logged.length).toBeGreaterThan(0);
      for (const secret of [state, challenge, verifier, 'auth-code-123', 'refresh-secret-value']) {
        expect(output).not.toContain(secret);
      }
      expect(output).not.toContain('oidc/auth');
      expect(output).not.toContain('eyJ');
    });
  });
});
