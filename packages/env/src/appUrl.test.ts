import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = { APP_URL: 'https://app.example.com', INTERNAL_APP_URL: undefined } as {
  APP_URL: string;
  INTERNAL_APP_URL?: string;
};

vi.mock('./app', () => ({
  get appEnv() {
    return mockEnv;
  },
}));

const load = async () => import('./appUrl');

describe('appUrl', () => {
  beforeEach(() => {
    mockEnv.APP_URL = 'https://app.example.com';
    mockEnv.INTERNAL_APP_URL = undefined;
  });

  it('returns the bare origin for an unscoped surface', async () => {
    const { getAppOriginUrl } = await load();
    expect(getAppOriginUrl()).toBe('https://app.example.com');
  });

  it('trims a trailing slash so joins never double up', async () => {
    mockEnv.APP_URL = 'https://app.example.com/';
    const { buildTenantUrl, getAppOriginUrl } = await load();
    expect(getAppOriginUrl()).toBe('https://app.example.com');
    expect(buildTenantUrl('/agent', 'acme')).toBe('https://app.example.com/t/acme/agent');
  });

  it('scopes a page url to the tenant', async () => {
    const { getTenantBaseUrl } = await load();
    expect(getTenantBaseUrl('acme')).toBe('https://app.example.com/t/acme');
  });

  it('falls back to the origin when there is no tenant', async () => {
    const { getTenantBaseUrl } = await load();
    // Sign-in and verification links genuinely have no tenant; throwing here
    // would push the branch back out to every call site.
    expect(getTenantBaseUrl(null)).toBe('https://app.example.com');
    expect(getTenantBaseUrl(undefined)).toBe('https://app.example.com');
  });

  it('builds page urls with and without a leading slash', async () => {
    const { buildTenantUrl } = await load();
    expect(buildTenantUrl('/agent/1', 'acme')).toBe('https://app.example.com/t/acme/agent/1');
    expect(buildTenantUrl('agent/1', 'acme')).toBe('https://app.example.com/t/acme/agent/1');
    expect(buildTenantUrl('/', 'acme')).toBe('https://app.example.com/t/acme');
  });

  it('never tenant-prefixes the server-to-server url', async () => {
    // A tenant prefix here 404s: it addresses an API route, not a page.
    mockEnv.INTERNAL_APP_URL = 'http://internal.svc';
    const { getInternalApiUrl } = await load();
    expect(getInternalApiUrl()).toBe('http://internal.svc');
  });

  it('falls back to APP_URL when INTERNAL_APP_URL is unset', async () => {
    const { getInternalApiUrl } = await load();
    expect(getInternalApiUrl()).toBe('https://app.example.com');
  });
});
