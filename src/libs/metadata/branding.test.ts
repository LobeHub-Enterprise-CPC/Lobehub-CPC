// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';

import { Ld } from './ld';
import { Meta } from './metadata';

vi.stubEnv('APP_URL', 'https://private.example');
vi.mock('@lobechat/business-const', async (original) => ({
  ...(await original<object>()),
  BRANDING_EMAIL: { support: 'support@private.example' },
  BRANDING_LOGO_URL: '/branding/logo.png',
  BRANDING_NAME: 'Private Workspace',
  ORG_NAME: 'Private Workspace',
  OFFICIAL_URL: 'https://private.example',
  SOCIAL_URL: {},
}));

describe('private distribution metadata', () => {
  it('uses the deployed organization, logo and contact without upstream founders', () => {
    const org = new Ld().genOrganization();
    expect(org.name).toBe('Private Workspace');
    expect(org.logo.url).toBe('https://private.example/branding/logo.png');
    expect(org.url).toBe('https://private.example/');
    expect(org.founders).toBeUndefined();
    expect(JSON.stringify(org)).not.toMatch(/lobehub|lobechat|arvin|canisminor/i);
  });
  it('brands link previews without inventing a social account', () => {
    const data = new Meta().generate({ title: 'Home', url: '/' });
    expect(data.description).toContain('Private Workspace');
    expect(data.openGraph).toHaveProperty('images', [
      { url: '/branding/logo.png', alt: 'Home · Private Workspace' },
    ]);
    expect(data.twitter).not.toHaveProperty('site', '@Private Workspace');
    expect(JSON.stringify(data)).not.toMatch(/lobehub|lobechat/i);
  });
});

afterAll(() => vi.unstubAllEnvs());
