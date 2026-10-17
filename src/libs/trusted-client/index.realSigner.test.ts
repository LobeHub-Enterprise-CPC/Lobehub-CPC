import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { describe, expect, it, vi } from 'vitest';

// The one test here does not mock the SDK: the point is that the PUBLISHED
// signer rejects a secret that merely has the length the app schema checks.
const { appEnv } = vi.hoisted(() => ({
  appEnv: {
    MARKET_TRUSTED_CLIENT_ID: 'client-id' as string | undefined,
    // Synthetic fixture, not a credential: 83 characters, not the SDK's format.
    MARKET_TRUSTED_CLIENT_SECRET: 'x'.repeat(83) as string | undefined,
  },
}));

vi.mock('@/envs/app', () => ({ appEnv }));

const { generateTrustedClientToken } = await import('./index');

describe('generateTrustedClientToken with the real SDK signer', () => {
  it('fails closed when the secret passes the app length check but the SDK rejects it', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const attempt = () =>
      runWithTenantScope(
        { session: {}, slug: 'a', tenantId: 'tenant-a' } as unknown as TenantScope,
        () => generateTrustedClientToken({ email: 'a@b.com', userId: 'user_real' }),
      );

    expect(attempt).toThrowError(expect.objectContaining({ code: 'TRUST_SIGNING_FAILED' }));
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('x'.repeat(83));
    errorSpy.mockRestore();
  });
});
