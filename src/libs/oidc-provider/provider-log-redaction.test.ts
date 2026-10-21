/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  capturedLogs,
  expectNoSecretsLogged,
  SENTINELS,
  startLogCapture,
  stopLogCapture,
} from './__tests__/logCapture';
import { createOIDCProvider } from './provider';

const state = vi.hoisted(() => ({
  config: undefined as any,
  findUser: vi.fn(),
  handlers: {} as Record<string, (...args: any[]) => void>,
}));

vi.mock('debug', async () => (await import('./__tests__/logCapture')).debugMock);
vi.mock('@lobechat/business-auth', () => ({
  assertBusinessUserAccess: vi.fn(),
  isBusinessAuthorizationError: () => false,
}));
vi.mock('oidc-provider', () => ({
  default: class {
    constructor(_issuer: string, config: unknown) {
      state.config = config;
    }
    on(event: string, handler: (...args: any[]) => void) {
      state.handlers[event] = handler;
    }
  },
  errors: {},
}));
vi.mock('@/database/models/user', () => ({ UserModel: { findById: state.findUser } }));
vi.mock('@/server/services/tenantDiscovery/otherOrganizations', () => ({
  hasOtherOrganizations: async () => undefined,
}));
vi.mock('@/server/modules/Tenant/endpoints', () => ({ findSlugEndpoint: async () => null }));
vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'http://localhost:3000' } }));
vi.mock('@/libs/oidc-provider/jwt', () => ({ getJWKS: () => ({ keys: [] }) }));
vi.mock('@/locales/resources', () => ({ normalizeLocale: (locale: string) => locale }));
vi.mock('./adapter', () => ({ DrizzleAdapter: { createAdapterFactory: () => class {} } }));
vi.mock('./config', () => ({ defaultClaims: {}, defaultClients: [], defaultScopes: ['openid'] }));
vi.mock('./cookies', () => ({ getOIDCCookieKeys: () => ['test-secret'] }));
vi.mock('./interaction-policy', () => ({ createInteractionPolicy: () => [] }));

const tenant = {
  slug: 'acme',
  endpoint: { basePath: '/t/acme', publicUrl: 'http://localhost:3000/t/acme', version: 1 },
  tenantId: 'tenant-acme',
};

describe('OIDC provider logs never carry credentials', () => {
  beforeEach(async () => {
    startLogCapture();
    state.findUser.mockResolvedValue({
      email: SENTINELS.cookie,
      id: 'alice',
      username: SENTINELS.cookie,
    });
    await createOIDCProvider({} as never, tenant);
  });

  afterEach(() => {
    stopLogCapture();
  });

  it('does not log interaction params or the interaction id', () => {
    const interaction = {
      params: { code_challenge: SENTINELS.challenge, state: SENTINELS.state, ui_locales: 'en-US' },
      prompt: { name: 'consent' },
      uid: SENTINELS.uid,
    };

    expect(state.config.interactions.url({ oidc: {} }, interaction)).toBe(
      `/t/acme/oauth/consent/${SENTINELS.uid}?hl=en-US`,
    );
    expect(
      state.config.interactions.url({ oidc: {} }, { ...interaction, prompt: { name: 'login' } }),
    ).toBe(`/t/acme/oidc/interaction/${SENTINELS.uid}/login?hl=en-US`);

    expect(capturedLogs()).not.toBe('');
    expectNoSecretsLogged();
  });

  it('does not log the account claims', async () => {
    const account = await state.config.findAccount({ oidc: {} }, 'alice');
    const claims = await account.claims('userinfo', 'openid profile email');

    expect(claims.sub).toBe('alice');
    expectNoSecretsLogged();
  });

  it('does not log the error text of a failing lookup, render or server error', async () => {
    const failure = new Error(`failed query params ${SENTINELS.state} ${SENTINELS.code}`);
    state.findUser.mockRejectedValueOnce(failure);

    await expect(state.config.findAccount({ oidc: {} }, 'alice')).rejects.toBeDefined();
    await state.config.renderError({ redirect: vi.fn() }, { error: 'invalid_request' }, failure);
    state.handlers['server_error']({}, failure);

    expect(console.error).toHaveBeenCalled();
    expectNoSecretsLogged();
  });

  it('keeps grant events to controlled codes', () => {
    const ctx = {
      oidc: {
        client: { clientId: 'lobehub-desktop' },
        params: {
          code: SENTINELS.code,
          code_verifier: SENTINELS.challenge,
          grant_type: 'authorization_code',
          refresh_token: SENTINELS.token,
        },
      },
      status: 400,
    };

    state.handlers['grant.error'](ctx, { error: 'invalid_grant', error_detail: 'grant not found' });
    state.handlers['grant.revoked'](ctx, SENTINELS.grant);

    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(capturedLogs()).toContain('invalid_grant');
    expectNoSecretsLogged();
  });
});
