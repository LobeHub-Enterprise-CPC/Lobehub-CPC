import { describe, expect, it } from 'vitest';

import { redirectCallbackError } from './callback-error-response';

const refused = (code: string) => Response.json({ code, message: code }, { status: 403 });

describe('redirectCallbackError', () => {
  it('sends a refused magic-link verification to the error page', async () => {
    const response = await redirectCallbackError(
      new Request('https://app.test/orgs/acme/api/auth/magic-link/verify?token=t'),
      refused('SEAT_LIMIT_REACHED'),
      '/orgs/acme/auth-error',
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/orgs/acme/auth-error?error=SEAT_LIMIT_REACHED');
  });

  it('sends a refused OAuth callback to the error page', async () => {
    const response = await redirectCallbackError(
      new Request('https://app.test/api/auth/oauth2/callback/corp?code=c&state=s'),
      refused('SSO_ACCESS_DENIED'),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/auth-error?error=SSO_ACCESS_DENIED');
  });

  it('leaves a successful magic-link verification alone', async () => {
    const ok = new Response(null, { headers: { Location: '/' }, status: 302 });

    expect(
      await redirectCallbackError(
        new Request('https://app.test/api/auth/magic-link/verify?token=t'),
        ok,
      ),
    ).toBe(ok);
  });

  it('keeps JSON for API calls that are not browser navigations', async () => {
    const response = refused('SEAT_LIMIT_REACHED');

    expect(
      await redirectCallbackError(
        new Request('https://app.test/api/auth/sign-up/email', { method: 'POST' }),
        response,
      ),
    ).toBe(response);
  });
});
