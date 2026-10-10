// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const mocks = vi.hoisted(() => ({
  appEnv: { CDN_USE_GLOBAL: true },
  authEnv: { ENABLE_OIDC: true },
  buildAnalyticsConfig: vi.fn(() => ({
    posthog: { debug: false, host: 'https://ph', key: 'phc' },
  })),
  getServerAuthConfig: vi.fn(() => ({
    disableEmailPassword: false,
    enableEmailVerification: true,
    enableMagicLink: false,
  })),
  getServerFeatureFlagsValue: vi.fn(() => ({ auth_captcha: true })),
  getTenantSsoProviders: vi.fn(async () => [
    { clientSecret: 'secret', displayName: 'Okta', providerId: 'okta' },
  ]),
}));

vi.mock('@/auth', () => ({ getTenantSsoProviders: mocks.getTenantSsoProviders }));

vi.mock('@/config/featureFlags', () => ({
  getServerFeatureFlagsValue: mocks.getServerFeatureFlagsValue,
}));

vi.mock('@/envs/app', () => ({ appEnv: mocks.appEnv }));

vi.mock('@/envs/auth', () => ({ authEnv: mocks.authEnv }));

vi.mock('@/libs/spaHtml', () => ({
  buildAnalyticsConfig: mocks.buildAnalyticsConfig,
}));

vi.mock('@/server/globalConfig/getServerAuthConfig', () => ({
  getServerAuthConfig: mocks.getServerAuthConfig,
}));

describe('GET /webapi/auth/spa-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes the env-level feature flags the auth shell maps onto state', async () => {
    const response = await GET(new Request('http://localhost/webapi/auth/spa-config'));
    const body = await response.json();

    expect(mocks.getServerFeatureFlagsValue).toHaveBeenCalled();
    expect(body.featureFlags).toEqual({ auth_captcha: true });
  });

  it("lists the tenant's SSO provider ids only and keeps the answer out of shared caches", async () => {
    const response = await GET(new Request('http://localhost/webapi/auth/spa-config'));
    const body = await response.json();

    expect(body.config.oAuthSSOProviders).toEqual(['okta']);
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
