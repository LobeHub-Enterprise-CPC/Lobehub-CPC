import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadCredentials, saveCredentials } from './credentials';
import { getValidToken } from './refresh';

vi.mock('./credentials', () => ({ loadCredentials: vi.fn(), saveCredentials: vi.fn() }));
vi.mock('../settings', () => ({ resolveServerUrl: () => 'https://example.test/t/a' }));
afterEach(() => vi.restoreAllMocks());

describe('stored source during asynchronous refresh', () => {
  it('does not overwrite a later login with a refresh from the previous login', async () => {
    const original = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 0 };
    let current = original;
    vi.mocked(loadCredentials).mockImplementation(() => current);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      current = { accessToken: 'other-login', refreshToken: 'other-refresh', expiresAt: 0 };
      return Response.json({
        access_token: 'late-old-access',
        refresh_token: 'late-old-refresh',
        expires_in: 3600,
      });
    });
    const result = await getValidToken();
    expect(saveCredentials).not.toHaveBeenCalled();
    expect(result.status).not.toBe('ok');
  });
});
