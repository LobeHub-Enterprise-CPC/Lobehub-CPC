import { describe, expect, it } from 'vitest';

describe('Google SSO provider', () => {
  it('should prompt account selection during OAuth sign in', async () => {
    const { default: provider } = await import('./google');

    // Credentials come from the tenant's `sso_providers`, not the environment.
    expect(
      provider.build({
        AUTH_GOOGLE_ID: 'google-client-id',
        AUTH_GOOGLE_SECRET: 'google-client-secret',
      }),
    ).toEqual(
      expect.objectContaining({
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
        prompt: 'select_account',
      }),
    );
  });
});
