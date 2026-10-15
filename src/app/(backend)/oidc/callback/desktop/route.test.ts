/**
 * @vitest-environment node
 */
import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const mocks = vi.hoisted(() => ({
  cleanupExpired: vi.fn(),
  create: vi.fn(),
}));

vi.mock('debug', () => ({ default: () => vi.fn() }));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  after: vi.fn(),
}));

vi.mock('@/database/server', () => ({ serverDB: {} }));

// The success/error pages live under the tenant's active entry, not the origin root.
vi.mock('@/server/modules/Tenant/callbackUrl', () => ({
  tenantPublicPath: (path: string) => `/t/acme${path}`,
}));

vi.mock('@/database/models/oauthHandoff', () => ({
  OAuthHandoffModel: class {
    cleanupExpired = mocks.cleanupExpired;
    create = mocks.create;
  },
}));

const createRequest = (search: string) => {
  const url = new URL(
    `https://lobehub-cloud-next-stable.vercel.app/oidc/callback/desktop${search}`,
  );
  return Object.assign(new Request(url), { nextUrl: url }) as unknown as NextRequest;
};

describe('GET /oidc/callback/desktop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores the handoff and redirects to the success page under the tenant entry', async () => {
    mocks.create.mockResolvedValue(undefined);

    const response = await GET(createRequest('?code=code-1&state=handoff-1'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/t/acme/oauth/callback/success');
    expect(mocks.create).toHaveBeenCalledWith({
      client: 'desktop',
      id: 'handoff-1',
      payload: { code: 'code-1', state: 'handoff-1' },
    });
  });

  it('does not put the failure text in the error page address', async () => {
    mocks.create.mockRejectedValue(
      new Error('insert into oauth_handoffs params: SENTINEL_HANDOFF, SENTINEL_CODE'),
    );

    const response = await GET(createRequest('?code=SENTINEL_CODE&state=SENTINEL_HANDOFF'));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!, 'https://example.com');
    expect(location.pathname).toBe('/t/acme/oauth/callback/error');
    expect(location.searchParams.get('reason')).toBe('internal_error');
    expect(location.search).not.toContain('SENTINEL');
    expect(location.searchParams.has('errorMessage')).toBe(false);
  });

  it('redirects to the error page under the tenant entry when params are missing', async () => {
    const response = await GET(createRequest(''));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      '/t/acme/oauth/callback/error?reason=invalid_request',
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
