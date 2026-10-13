import { initializeTenant } from '@lobechat/business-tenant/client';
import { describe, expect, it } from 'vitest';

import { signInUrlFor } from './signInRedirect';

describe('signInUrlFor', () => {
  it('signs in under the tenant path and returns to the consent page', () => {
    const consent = new URL('http://localhost:3591/t/acme/oauth/consent/uid-1?hl=en-US');
    initializeTenant(consent);

    const url = new URL(signInUrlFor(consent), consent);

    expect(url.pathname).toBe('/t/acme/signin');
    expect(url.searchParams.get('callbackUrl')).toBe(consent.href);
  });

  it('signs in at the root of a custom domain entry', () => {
    const consent = new URL('https://chat.acme.example/oauth/consent/uid-1');
    initializeTenant(consent, { basePath: '', slug: 'acme' });

    const url = new URL(signInUrlFor(consent), consent);

    expect(url.pathname).toBe('/signin');
    expect(url.searchParams.get('callbackUrl')).toBe(consent.href);
  });
});
