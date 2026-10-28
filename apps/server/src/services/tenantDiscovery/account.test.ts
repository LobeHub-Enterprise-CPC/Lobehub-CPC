import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findAccountOrganizations, loadAccountOrganization } from './account';

const deps = vi.hoisted(() => ({
  admit: vi.fn(),
  candidates: vi.fn(),
  lookup: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@/server/services/redis', () => ({
  redisService: { tenantDiscovery: { admit: deps.admit } },
}));
vi.mock('./candidates', () => ({ loadDiscoveryCandidates: deps.candidates }));
vi.mock('./connection', () => ({ withLookupClient: deps.lookup }));
vi.mock('./query', () => ({ queryTenantMembership: deps.query }));

const candidate = {
  activeUrl: 'https://app.example.com/orgs/acme',
  endpointVersion: 1,
  id: 'tenant-1',
  name: 'Acme',
};
const headers = new Headers({ 'x-real-ip': '192.0.2.1' });
const signal = new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KEY_VAULTS_SECRET', 'account-service-test-secret');
  deps.admit.mockResolvedValue(null);
  deps.candidates.mockResolvedValue([candidate]);
  deps.lookup.mockImplementation(async (_signal: AbortSignal, work: (client: object) => unknown) =>
    work({}),
  );
  deps.query.mockResolvedValue([candidate]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('remembered-account lookups', () => {
  it('charges the account budget with the mailbox fingerprint and returns the membership', async () => {
    await expect(
      findAccountOrganizations({ email: 'user@example.com', headers, signal }),
    ).resolves.toEqual([candidate]);
    expect(deps.admit).toHaveBeenCalledWith(
      'account',
      '192.0.2.1',
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(deps.query.mock.lastCall?.[2]).toBe('user@example.com');
    expect(deps.query.mock.lastCall?.[1]).toEqual([candidate]);
  });

  it('fails rate-limited work before loading candidates', async () => {
    deps.admit.mockResolvedValueOnce(31);
    await expect(
      findAccountOrganizations({ email: 'user@example.com', headers, signal }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 31, status: 429 });
    expect(deps.candidates).not.toHaveBeenCalled();
  });

  it('selects only an available organization of the remembered email', async () => {
    await expect(loadAccountOrganization(signal, 'user@example.com', 'tenant-1')).resolves.toEqual(
      candidate,
    );
    expect(deps.candidates).toHaveBeenCalledWith(signal, 'tenant-1');
    expect(deps.query.mock.lastCall?.[2]).toBe('user@example.com');
  });

  it.each([
    ['the organization is unknown', () => deps.candidates.mockResolvedValueOnce([])],
    ['the email is not a member', () => deps.query.mockResolvedValueOnce([])],
  ])('answers TENANT_NOT_AVAILABLE when %s', async (_name, arrange) => {
    arrange();
    await expect(
      loadAccountOrganization(signal, 'user@example.com', 'tenant-1'),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_AVAILABLE', status: 404 });
  });
});
