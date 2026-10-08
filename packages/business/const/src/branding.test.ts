import { describe, expect, it } from 'vitest';

import { BRANDING_EMAIL, BRANDING_URL, SOCIAL_URL } from './branding';

describe('default branding', () => {
  it('keeps the upstream subscription and community destinations', () => {
    expect(BRANDING_URL.subscription).toBe('https://app.lobehub.com/settings/plans');
    expect(SOCIAL_URL).toEqual({
      discord: 'https://discord.gg/AYFPHvv2jT',
      github: 'https://github.com/lobehub',
      medium: 'https://medium.com/@lobehub',
      x: 'https://x.com/lobehub',
      youtube: 'https://www.youtube.com/@lobehub',
    });
  });

  it('keeps the upstream contact addresses', () => {
    expect(BRANDING_EMAIL.business).toBe('hello@lobehub.com');
    expect(BRANDING_EMAIL.support).toBe('support@lobehub.com');
  });
});

describe('BRANDING_EMAIL', () => {
  it('leaves Reply-To unset by default for self-hosted deployments', () => {
    expect(BRANDING_EMAIL.replyTo).toBeUndefined();
  });
});
