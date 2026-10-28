import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readDesktopHandoff, selectDesktopTenant } from './desktop';
import { parseDesktopFlow } from './desktopFlow';
import { DiscoveryError, unavailable } from './errors';

const deps = vi.hoisted(() => ({
  admit: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  read: vi.fn(),
  candidates: vi.fn(),
  lookup: vi.fn(),
  verify: vi.fn(),
}));
vi.mock('@/server/services/redis', () => ({
  redisService: {
    tenantDiscovery: {
      admit: deps.admit,
      getDesktopSelection: deps.get,
      putDesktopSelection: deps.put,
      readDesktopHandoff: deps.read,
    },
  },
}));
vi.mock('./candidates', () => ({ loadDiscoveryCandidates: deps.candidates }));
vi.mock('./connection', () => ({ withLookupClient: deps.lookup }));
vi.mock('./query', () => ({ verifyCandidateObjects: deps.verify }));

const flow = {
  state: 'a'.repeat(32),
  codeChallenge: createHash('sha256').update('test-verifier').digest('base64url'),
};
const headers = new Headers({ 'x-real-ip': '192.0.2.1' });
const candidate = {
  id: 'tenant-1',
  name: 'Acme',
  activeUrl: 'https://app.example.com/t/acme',
  endpointVersion: 7,
};
const snapshot = () => ({
  tenantId: candidate.id,
  name: candidate.name,
  entry: candidate.activeUrl,
  endpointVersion: 7,
  codeChallenge: flow.codeChallenge,
  expiresAt: Date.now() + 600_000,
});
const select = () =>
  selectDesktopTenant({
    headers,
    flow,
    tenantId: candidate.id,
    signal: new AbortController().signal,
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KEY_VAULTS_SECRET', 'unit-test-key');
  deps.admit.mockResolvedValue(null);
  deps.get.mockResolvedValue(null);
  deps.candidates.mockResolvedValue([candidate]);
  deps.lookup.mockImplementation(async (_signal, fn) => fn({}));
  deps.verify.mockResolvedValue(undefined);
  deps.put.mockImplementation(async (_hash, value) => value);
  deps.read.mockResolvedValue(snapshot());
});
afterEach(() => vi.unstubAllEnvs());

describe('desktop flow format', () => {
  it('accepts the actual 16-byte hex state and SHA-256 base64url challenge', () => {
    expect(parseDesktopFlow(flow)).toEqual(flow);
  });
  it.each([
    { ...flow, state: 'A'.repeat(32) },
    { ...flow, state: 'a'.repeat(31) },
    { ...flow, state: 'a'.repeat(33) },
    { ...flow, codeChallenge: 'a'.repeat(42) },
    { ...flow, codeChallenge: 'a'.repeat(44) },
    { ...flow, codeChallenge: '+'.repeat(43) },
    { ...flow, extra: true },
    {},
    null,
  ])('rejects an invalid flow without accepting protocol extensions', (value) => {
    expect(parseDesktopFlow(value)).toBeNull();
  });
});

describe('immutable desktop selection', () => {
  it('uses one selected candidate snapshot and constructs only the fixed authorization parameter whitelist', async () => {
    const result = await select();
    const url = new URL(result.url);
    expect(url.origin + url.pathname).toBe('https://app.example.com/t/acme/oidc/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'tituwork-desktop',
      code_challenge: flow.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'consent',
      redirect_uri: 'https://app.example.com/t/acme/oidc/callback/desktop',
      resource: 'urn:lobehub:chat',
      response_type: 'code',
      scope: 'openid profile email offline_access',
      state: flow.state,
    });
    expect(deps.put.mock.lastCall?.[1]).toMatchObject({
      tenantId: candidate.id,
      name: 'Acme',
      entry: candidate.activeUrl,
      endpointVersion: 7,
    });
    expect(deps.put.mock.lastCall?.[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(deps.put.mock.lastCall?.[0]).not.toContain(flow.state);
    expect(deps.candidates).toHaveBeenCalledTimes(1);
    expect(deps.admit).toHaveBeenCalledTimes(1);
  });
  it('replays the original snapshot without reading a moved or frozen current tenant', async () => {
    const first = await select();
    deps.get.mockResolvedValue(deps.put.mock.lastCall?.[1]);
    deps.candidates.mockRejectedValue(new Error('current tenant is unavailable'));
    const before = deps.candidates.mock.calls.length;
    expect(await select()).toEqual(first);
    expect(deps.candidates).toHaveBeenCalledTimes(before);
    expect(deps.put).toHaveBeenCalledTimes(1);
  });
  it.each(['tenant', 'challenge', 'malformed', 'expired'])(
    'refuses an existing %s conflict without modifying it',
    async (kind) => {
      const value =
        kind === 'malformed'
          ? { broken: true }
          : {
              ...snapshot(),
              ...(kind === 'tenant'
                ? { tenantId: 'other' }
                : kind === 'challenge'
                  ? { codeChallenge: 'b'.repeat(43) }
                  : { expiresAt: Date.now() - 1 }),
            };
      deps.get.mockResolvedValue(value);
      await expect(select()).rejects.toMatchObject({ code: 'HANDOFF_EXISTS', status: 409 });
      expect(deps.candidates).not.toHaveBeenCalled();
      expect(deps.put).not.toHaveBeenCalled();
    },
  );
  it('returns the racing immutable winner rather than the current endpoint and rejects a different winner', async () => {
    const old = {
      ...snapshot(),
      entry: 'https://old.example.com',
      name: 'Original',
      endpointVersion: 3,
    };
    deps.put.mockResolvedValueOnce(old);
    expect(new URL((await select()).url).origin).toBe('https://old.example.com');
    deps.put.mockResolvedValueOnce({ ...old, tenantId: 'other' });
    await expect(select()).rejects.toMatchObject({ code: 'HANDOFF_EXISTS' });
  });
  it('fails closed before database work when Redis is limited or unavailable', async () => {
    deps.admit.mockResolvedValueOnce(17);
    await expect(select()).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 17 });
    deps.admit.mockRejectedValueOnce(new Error('unavailable'));
    await expect(select()).rejects.toThrow('unavailable');
    expect(deps.candidates).not.toHaveBeenCalled();
  });
  it('distinguishes ineligible/incomplete tenant from a platform outage for the GET fallback', async () => {
    deps.candidates.mockResolvedValueOnce([]);
    await expect(select()).rejects.toMatchObject({ code: 'TENANT_NOT_AVAILABLE' });
    deps.candidates.mockRejectedValueOnce(unavailable());
    await expect(select()).rejects.toMatchObject({ code: 'TENANT_DISCOVERY_UNAVAILABLE' });
    deps.candidates.mockRejectedValueOnce(unavailable());
    await expect(select()).rejects.toMatchObject({ code: 'TENANT_DISCOVERY_UNAVAILABLE' });
  });
  it('does not publish a snapshot after cancellation', async () => {
    const controller = new AbortController();
    deps.verify.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(
      selectDesktopTenant({ headers, flow, tenantId: candidate.id, signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(deps.put).not.toHaveBeenCalled();
  });
});

describe('desktop platform handoff', () => {
  const read = () => readDesktopHandoff({ headers, flow, signal: new AbortController().signal });
  it('uses its independent Redis-only budget and returns only the public snapshot', async () => {
    expect(await read()).toEqual({
      tenantId: candidate.id,
      name: 'Acme',
      entry: candidate.activeUrl,
      endpointVersion: 7,
    });
    expect(deps.admit).toHaveBeenCalledWith('handoff', '192.0.2.1');
    expect(deps.candidates).not.toHaveBeenCalled();
    expect(deps.lookup).not.toHaveBeenCalled();
    expect(await read()).toEqual({
      tenantId: candidate.id,
      name: 'Acme',
      entry: candidate.activeUrl,
      endpointVersion: 7,
    });
  });
  it('returns not found for a missing, mismatched or invalid snapshot without changing it', async () => {
    for (const value of [null, {}, { ...snapshot(), expiresAt: 1 }]) {
      deps.read.mockResolvedValueOnce(value);
      await expect(read()).rejects.toMatchObject({ code: 'HANDOFF_NOT_FOUND', status: 404 });
    }
    expect(deps.put).not.toHaveBeenCalled();
  });
  it('honors rate limiting before lookup', async () => {
    deps.admit.mockResolvedValueOnce(12);
    await expect(read()).rejects.toBeInstanceOf(DiscoveryError);
    expect(deps.read).not.toHaveBeenCalled();
  });
});
