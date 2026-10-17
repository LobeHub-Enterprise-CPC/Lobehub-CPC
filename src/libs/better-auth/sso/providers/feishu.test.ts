import { afterEach, describe, expect, it, vi } from 'vitest';

import provider from './feishu';

const userInfo = async (profile: Record<string, string>) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ code: 0, data: profile })),
  );
  const config = provider.build({ AUTH_FEISHU_APP_ID: 'id', AUTH_FEISHU_APP_SECRET: 'secret' });
  return config.getUserInfo!({ accessToken: 'token' } as never);
};

describe('Feishu SSO provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats the organisation-assigned enterprise email as verified', async () => {
    const user = await userInfo({
      email: 'personal@example.com',
      enterprise_email: 'alice@corp.example',
      union_id: 'on_1',
    });

    expect(user).toEqual(
      expect.objectContaining({ email: 'alice@corp.example', emailVerified: true, id: 'on_1' }),
    );
  });

  it.each([
    [
      'a personal email',
      { email: 'personal@example.com', union_id: 'on_1' },
      'personal@example.com',
    ],
    ['no email', { union_id: 'on_1' }, 'on_1@feishu.sso'],
  ])('does not verify %s', async (_case, profile, email) => {
    expect(await userInfo(profile)).toEqual(
      expect.objectContaining({ email, emailVerified: false }),
    );
  });
});
