/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';

import { isSessionOnlyReasons, loginInteractionResult } from './interactionLogin';

vi.mock('@/auth', () => ({ getTenantAuth: vi.fn() }));

const session = { ts: 1_700_000_000, userId: 'user-1' };

describe('isSessionOnlyReasons', () => {
  it.each([
    [['no_session']],
    [['tenant_session_mismatch']],
    [['no_session', 'tenant_session_mismatch']],
  ])('accepts %j', (reasons) => {
    expect(isSessionOnlyReasons(reasons)).toBe(true);
  });

  it.each([
    [undefined],
    [[]],
    [['login_prompt']],
    [['max_age']],
    [['no_session', 'max_age']],
    [['tenant_session_mismatch', 'login_prompt']],
    [['id_token_hint']],
  ])('rejects %j', (reasons) => {
    expect(isSessionOnlyReasons(reasons)).toBe(false);
  });
});

describe('loginInteractionResult', () => {
  it('logs the session account in when only the session is at issue', () => {
    expect(loginInteractionResult(['tenant_session_mismatch'], session)).toEqual({
      login: { accountId: 'user-1', remember: true, ts: 1_700_000_000 },
    });
  });

  it('refuses re-authentication for any other reason', () => {
    expect(loginInteractionResult(['tenant_session_mismatch', 'max_age'], session)).toEqual({
      error: 'login_required',
      error_description: 'Re-authentication is not supported',
    });
  });
});
