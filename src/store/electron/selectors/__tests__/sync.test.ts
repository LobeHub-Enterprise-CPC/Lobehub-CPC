import { afterEach, describe, expect, it } from 'vitest';

import { type ElectronState, initialState } from '../../initialState';
import { electronSyncSelectors } from '../sync';

const stateWith = (dataSyncConfig: ElectronState['dataSyncConfig']) =>
  ({ dataSyncConfig }) as ElectronState;

const withConfig = (dataSyncConfig: ElectronState['dataSyncConfig']): ElectronState => ({
  ...initialState,
  dataSyncConfig,
});

const originalCloudServer = process.env.OFFICIAL_CLOUD_SERVER;

afterEach(() => {
  if (originalCloudServer === undefined) delete process.env.OFFICIAL_CLOUD_SERVER;
  else process.env.OFFICIAL_CLOUD_SERVER = originalCloudServer;
});

describe('electronSyncSelectors.remoteServerUrl', () => {
  const cloudTenant = (
    entryUrl: string,
  ): NonNullable<ElectronState['dataSyncConfig']['cloudTenant']> => ({
    display: { account: 'sub' },
    entryUrl,
    generation: 'login-A',
    identity: { issuer: `${entryUrl}/oidc`, subject: 'sub', tenantId: 'A' },
  });

  // Regression: the renderer used to return the platform root for every cloud login, while the
  // main process talks to the committed tenant entry. Links, avatars and OAuth redirect URIs built
  // from the platform root lose `/t/{slug}` and fail with TENANT_REQUIRED.
  it('names the committed tenant entry in cloud mode, not the platform origin', () => {
    process.env.OFFICIAL_CLOUD_SERVER = 'https://host';

    expect(
      electronSyncSelectors.remoteServerUrl(
        stateWith({ cloudTenant: cloudTenant('https://host/t/acme/'), storageMode: 'cloud' }),
      ),
    ).toBe('https://host/t/acme');
  });

  it('has no business address in cloud mode before a tenant is committed', () => {
    process.env.OFFICIAL_CLOUD_SERVER = 'https://host';

    expect(electronSyncSelectors.remoteServerUrl(stateWith({ storageMode: 'cloud' }))).toBe('');
    expect(
      electronSyncSelectors.remoteServerUrl(
        stateWith({ remoteServerUrl: 'https://host', storageMode: 'cloud' }),
      ),
    ).toBe('');
  });

  it('prefers the committed tenant entry over a self-hosted platform address', () => {
    expect(
      electronSyncSelectors.remoteServerUrl(
        stateWith({
          cloudTenant: cloudTenant('https://host/t/acme'),
          remoteServerUrl: 'https://host',
          storageMode: 'selfHost',
        }),
      ),
    ).toBe('https://host/t/acme');
  });

  it('uses the configured address for a legacy self-hosted login', () => {
    expect(
      electronSyncSelectors.remoteServerUrl(
        stateWith({ remoteServerUrl: 'https://self.hosted', storageMode: 'selfHost' }),
      ),
    ).toBe('https://self.hosted');
  });

  it('returns an empty string for self-host with nothing configured', () => {
    expect(electronSyncSelectors.remoteServerUrl(stateWith({ storageMode: 'selfHost' }))).toBe('');
  });

  // The configured address is a tenant address (`https://host/t/acme`) or a
  // custom-domain root. Consumers append app paths to it, so it has to keep the
  // tenant prefix and carry no trailing slash.
  it.each([
    ['https://host/t/acme', 'https://host/t/acme'],
    ['https://host/t/acme/', 'https://host/t/acme'],
    ['https://host/t/acme//', 'https://host/t/acme'],
    ['https://custom.host/', 'https://custom.host'],
    ['https://custom.host', 'https://custom.host'],
  ])('keeps the tenant path of %s and drops trailing slashes', (configured, expected) => {
    expect(
      electronSyncSelectors.remoteServerUrl(
        stateWith({ remoteServerUrl: configured, storageMode: 'selfHost' }),
      ),
    ).toBe(expected);
  });
});

describe('electronSyncSelectors.isOfficialServer', () => {
  it('recognizes a vendor cloud build independently of its stored remoteServerUrl', () => {
    process.env.OFFICIAL_CLOUD_SERVER = 'https://lobehub.com';
    expect(
      electronSyncSelectors.isOfficialServer(
        withConfig({ remoteServerUrl: 'http://localhost:3210', storageMode: 'cloud' }),
      ),
    ).toBe(true);
  });

  it('is official when self-hosting on a lobehub.com origin', () => {
    expect(
      electronSyncSelectors.isOfficialServer(
        withConfig({ remoteServerUrl: 'https://lobehub.com', storageMode: 'selfHost' }),
      ),
    ).toBe(true);
  });

  it('is not official for a third-party self-hosted server', () => {
    expect(
      electronSyncSelectors.isOfficialServer(
        withConfig({ remoteServerUrl: 'https://chat.example.com', storageMode: 'selfHost' }),
      ),
    ).toBe(false);
  });
});

describe('electronSyncSelectors.serverConfigScope', () => {
  const committed: ElectronState = {
    ...initialState,
    isInitRemoteServerConfig: true,
    dataSyncConfig: {
      active: true,
      storageMode: 'cloud',
      cloudTenant: {
        entryUrl: 'https://example.test/t/A',
        generation: 'login-A',
        identity: { tenantId: 'A', subject: 'same-sub', issuer: 'https://example.test/t/A/oidc' },
        display: { account: 'same-sub' },
      },
    },
  };
  const scope = electronSyncSelectors.serverConfigScope;
  const legacy: ElectronState = {
    ...initialState,
    isInitRemoteServerConfig: true,
    dataSyncConfig: {
      active: true,
      storageMode: 'selfHost',
      remoteServerUrl: 'https://example.test/t/A',
    },
  };

  it('accepts main-supported legacy selfHost restoration with a normalized HTTP(S) address', () => {
    expect(scope(legacy)).not.toBeNull();
    expect(
      scope({
        ...legacy,
        dataSyncConfig: {
          ...legacy.dataSyncConfig,
          remoteServerUrl: ' HTTPS://EXAMPLE.TEST/t/A/ ',
        },
      }),
    ).toBe(scope(legacy));
    expect(
      scope({
        ...legacy,
        dataSyncConfig: { ...legacy.dataSyncConfig, remoteServerUrl: 'http://localhost:3010/t/A' },
      }),
    ).not.toBeNull();
    expect(
      scope({
        ...legacy,
        dataSyncConfig: { ...legacy.dataSyncConfig, remoteServerUrl: 'https://example.test/t/B' },
      }),
    ).not.toBe(scope(legacy));
  });

  it.each([
    undefined,
    '',
    '  ',
    'not a URL',
    '//example.test',
    'ftp://example.test',
    'javascript:alert(1)',
  ])('rejects invalid legacy selfHost address %s', (remoteServerUrl) => {
    expect(
      scope({ ...legacy, dataSyncConfig: { ...legacy.dataSyncConfig, remoteServerUrl } }),
    ).toBeNull();
  });

  it('keeps legacy restoration disabled until hydration, activation and endpoint availability', () => {
    expect(scope({ ...legacy, isInitRemoteServerConfig: false })).toBeNull();
    expect(
      scope({ ...legacy, dataSyncConfig: { ...legacy.dataSyncConfig, active: false } }),
    ).toBeNull();
    expect(scope({ ...legacy, tenantEndpointChanged: 'update_address_required' })).toBeNull();
  });

  it('never substitutes the legacy address for an existing invalid binding', () => {
    expect(
      scope({
        ...legacy,
        dataSyncConfig: {
          ...legacy.dataSyncConfig,
          cloudTenant: { ...committed.dataSyncConfig.cloudTenant!, generation: '' },
        },
      }),
    ).toBeNull();
  });

  it('keeps confirmed selfHost on the committed binding scope', () => {
    expect(
      scope({
        ...committed,
        dataSyncConfig: {
          ...committed.dataSyncConfig,
          storageMode: 'selfHost',
          remoteServerUrl: 'https://example.test/t/A',
        },
      }),
    ).toBe(scope(committed));
  });

  it('requires hydration and an active committed binding, rather than a platform URL', () => {
    expect(scope({ ...committed, isInitRemoteServerConfig: false })).toBeNull();
    expect(
      scope({
        ...withConfig({
          active: true,
          storageMode: 'cloud',
          remoteServerUrl: 'https://example.test',
        }),
        isInitRemoteServerConfig: true,
      }),
    ).toBeNull();
    expect(
      scope({ ...committed, dataSyncConfig: { ...committed.dataSyncConfig, active: false } }),
    ).toBeNull();
    expect(scope({ ...committed, tenantEndpointChanged: 'relogin_required' })).toBeNull();
    expect(scope(committed)).not.toBeNull();
  });

  it('separates a new generation or another tenant with the same subject', () => {
    const tenant = committed.dataSyncConfig.cloudTenant!;
    for (const changed of [
      { ...tenant, generation: 'login-A-2' },
      { ...tenant, entryUrl: 'https://example.test/t/B' },
      { ...tenant, identity: { ...tenant.identity, tenantId: 'B' } },
      { ...tenant, identity: { ...tenant.identity, subject: 'other-sub' } },
      { ...tenant, identity: { ...tenant.identity, issuer: 'https://example.test/t/B/oidc' } },
    ]) {
      expect(
        scope({
          ...committed,
          dataSyncConfig: { ...committed.dataSyncConfig, cloudTenant: changed },
        }),
      ).not.toBe(scope(committed));
    }
  });

  it('retains the committed scope while another login awaits confirmation', () => {
    expect(
      scope({
        ...committed,
        pendingAuthorizationConfirmation: {
          account: 'same-sub',
          confirmationId: 'B',
          entryUrl: 'https://example.test/t/B',
          expiresAt: 9999999999999,
          generation: 'login-B',
        },
      }),
    ).toBe(scope(committed));
  });
});
