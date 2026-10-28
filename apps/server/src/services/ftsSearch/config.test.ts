// @vitest-environment node
import { tenantHash } from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ftsSearchEnv: {} as Record<string, string | undefined>,
  scope: undefined as { tenantId: string } | undefined,
}));

vi.mock('@/envs/ftsSearch', () => ({ ftsSearchEnv: mocks.ftsSearchEnv }));
vi.mock('@lobechat/database/tenant/requestScope', () => ({
  currentTenantScope: () => mocks.scope,
}));

const TENANT_NAMESPACE = `lobehub-${tenantHash('tenant-a')}`;

const loadConfig = async () => {
  vi.resetModules();
  const { loadElasticsearchFtsSearchConfig } = await import('./index');
  return loadElasticsearchFtsSearchConfig();
};

describe('loadElasticsearchFtsSearchConfig', () => {
  beforeEach(() => {
    for (const key of Object.keys(mocks.ftsSearchEnv)) delete mocks.ftsSearchEnv[key];
    mocks.ftsSearchEnv.ES_INDEX_NAMESPACE = 'lobehub';
    mocks.ftsSearchEnv.ES_URL = 'https://search.example.com';
    mocks.scope = { tenantId: 'tenant-a' };
  });

  it("uses the tenant's own index namespace and nothing outside a tenant", async () => {
    mocks.ftsSearchEnv.ES_API_KEY = 'test-api-key';

    await expect(loadConfig()).resolves.toMatchObject({ indexNamespace: TENANT_NAMESPACE });

    mocks.scope = undefined;
    await expect(loadConfig()).resolves.toBeUndefined();
  });

  it('loads the Elastic Cloud configuration with an API key', async () => {
    mocks.ftsSearchEnv.ES_API_KEY = 'test-api-key';

    await expect(loadConfig()).resolves.toEqual({
      allowInsecureHttp: false,
      apiKey: 'test-api-key',
      indexNamespace: TENANT_NAMESPACE,
      url: 'https://search.example.com',
    });
  });

  it('remains unconfigured without an API key unless insecure HTTP is explicitly allowed', async () => {
    await expect(loadConfig()).resolves.toBeUndefined();

    mocks.ftsSearchEnv.ES_ALLOW_INSECURE_HTTP = 'false';
    await expect(loadConfig()).resolves.toBeUndefined();
  });

  it('loads a private-network configuration without an API key when explicitly allowed', async () => {
    mocks.ftsSearchEnv.ES_ALLOW_INSECURE_HTTP = 'true';
    mocks.ftsSearchEnv.ES_URL = 'http://elasticsearch:9200';

    await expect(loadConfig()).resolves.toEqual({
      allowInsecureHttp: true,
      apiKey: undefined,
      indexNamespace: TENANT_NAMESPACE,
      url: 'http://elasticsearch:9200',
    });
  });

  it('remains unconfigured without a URL or namespace', async () => {
    mocks.ftsSearchEnv.ES_API_KEY = 'test-api-key';
    delete mocks.ftsSearchEnv.ES_URL;
    await expect(loadConfig()).resolves.toBeUndefined();

    mocks.ftsSearchEnv.ES_URL = 'https://search.example.com';
    delete mocks.ftsSearchEnv.ES_INDEX_NAMESPACE;
    await expect(loadConfig()).resolves.toBeUndefined();
  });
});
