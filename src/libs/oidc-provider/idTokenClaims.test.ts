/**
 * @vitest-environment node
 */
import Provider from 'oidc-provider';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'https://example.com' } }));

const client = {
  client_id: 'desktop',
  redirect_uris: ['https://example.com/cb'],
  token_endpoint_auth_method: 'none',
};

// The same filter oidc-provider applies to the claims of the id_token (see IdToken#payload).
const filteredClaims = async (claimsConfig: Record<string, string[]>, scope: string) => {
  const provider = new Provider('https://example.com/oidc', {
    claims: claimsConfig,
    clients: [client],
    conformIdTokenClaims: false,
  });
  const found = await provider.Client.find('desktop');
  const available = {
    sub: 'alice',
    tenant_name: 'Acme',
    tenant_slug: 'acme',
    has_other_organizations: true,
  };
  const mask = new (provider as any).Claims(available, { client: found });
  mask.scope(scope);
  return mask.result();
};

describe('organization display claims registration', () => {
  it('lets the id_token carry the organization claims under the openid scope', async () => {
    const { defaultClaims } = await import('./config');

    expect(await filteredClaims(defaultClaims, 'openid')).toEqual({
      sub: 'alice',
      tenant_name: 'Acme',
      tenant_slug: 'acme',
      has_other_organizations: true,
    });
  });

  it('would drop unregistered claims, which is why they are registered', async () => {
    expect(await filteredClaims({ openid: ['sub'] }, 'openid')).toEqual({ sub: 'alice' });
  });
});
