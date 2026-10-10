// @vitest-environment node
import type { SsoProviderItem } from '@lobechat/database/tenant/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sealTenantData } from '@/server/crypto/tenantKeys';

import {
  ssoSecretAad,
  tenantSsoCallbackPath,
  toGenericOAuthConfig,
  toTenantSsoProvider,
} from '../index';

const TENANT = 'tenant-sso-1';
const previousSecret = process.env.KEY_VAULTS_SECRET;

const row = (overrides: Partial<SsoProviderItem> = {}): SsoProviderItem => ({
  admissionPolicy: 'allowlist',
  createdAt: new Date(),
  deletedAt: null,
  displayName: 'Okta',
  enabled: true,
  id: 'sso_1',
  issuer: 'https://idp.example.com/',
  logoUrl: null,
  oauth2Config: null,
  oidcConfig: { clientId: 'client-1', pkce: true, scopes: ['openid', 'profile', 'email'] },
  protocol: 'oidc',
  providerId: 'okta',
  revision: 3,
  samlConfig: null,
  secretConfigEncrypted: sealTenantData(
    TENANT,
    JSON.stringify({ clientSecret: 's3cret' }),
    ssoSecretAad(TENANT, 'okta', 3),
  ),
  updatedAt: new Date(),
  ...overrides,
});

beforeAll(() => {
  process.env.KEY_VAULTS_SECRET = 'sso-test-master-secret';
});

afterAll(() => {
  process.env.KEY_VAULTS_SECRET = previousSecret;
});

describe('tenant SSO reader', () => {
  it('opens the secret sealed for this tenant, provider and revision', () => {
    const provider = toTenantSsoProvider(TENANT, row());
    expect(provider?.secrets.clientSecret).toBe('s3cret');

    const config = toGenericOAuthConfig(
      provider!,
      `https://app.example.com${tenantSsoCallbackPath('acme', 'okta')}`,
    );
    expect(config).toMatchObject({
      clientId: 'client-1',
      clientSecret: 's3cret',
      discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
      providerId: 'okta',
      redirectURI: 'https://app.example.com/t/acme/api/auth/callback/okta',
    });
  });

  it('drops a provider whose secret was sealed for another tenant or revision', () => {
    expect(toTenantSsoProvider('tenant-other', row())).toBeNull();
    expect(toTenantSsoProvider(TENANT, row({ revision: 4 }))).toBeNull();
  });

  it('drops disabled, deleted and unsupported providers', () => {
    expect(toTenantSsoProvider(TENANT, row({ enabled: false }))).toBeNull();
    expect(toTenantSsoProvider(TENANT, row({ deletedAt: new Date() }))).toBeNull();
    const saml = toTenantSsoProvider(
      TENANT,
      row({
        protocol: 'saml',
        samlConfig: {
          cert: 'certificate',
          entryPoint: 'https://idp.example.com/saml',
          idpMetadata: { metadata: '<xml />' },
          mapping: { emailVerified: 'email_verified' },
        },
      }),
    );
    expect(saml && toGenericOAuthConfig(saml, 'https://x')).toBeNull();
  });
});
