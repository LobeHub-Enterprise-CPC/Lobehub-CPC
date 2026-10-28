/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import authError from '@/locales/default/authError';

import zhAuthError from '../../../../locales/zh-CN/authError.json';
import AuthErrorPage from './index';

// Real translations, so a code without copy falls back to UNKNOWN and fails.
vi.unmock('react-i18next');

const renderPage = async (lng: 'en-US' | 'zh-CN', error: string) => {
  const i18n = createInstance();
  await i18n.init({
    lng,
    resources: { 'en-US': { authError }, 'zh-CN': { authError: zhAuthError } },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[`/auth-error?error=${error}`]}>
        <AuthErrorPage />
      </MemoryRouter>
    </I18nextProvider>,
  );
};

// Codes produced by the external IdP / Better Auth OAuth flow, which users hit
// during SSO sign-in and must be told why it failed and what to do next.
const SSO_CODES = [
  'ACCESS_DENIED',
  'ACCOUNT_NOT_LINKED',
  'INVALID_SCOPE',
  'OAUTH_CODE_VERIFICATION_FAILED',
] as const;

describe('AuthErrorPage SSO error codes', () => {
  it.each(['en-US', 'zh-CN'] as const)('shows specific copy for each code in %s', async (lng) => {
    const messages: Record<string, string | undefined> = lng === 'en-US' ? authError : zhAuthError;
    const unknown = messages['codes.UNKNOWN']!;

    for (const code of SSO_CODES) {
      const copy = messages[`codes.${code}`];
      expect(copy, `${lng} copy for ${code}`).toBeTruthy();

      const { unmount } = await renderPage(lng, code.toLowerCase());
      expect(screen.getByText(copy!)).toBeInTheDocument();
      expect(screen.queryByText(unknown)).not.toBeInTheDocument();
      expect(screen.getByText(new RegExp(`${code}$`))).toBeInTheDocument();
      unmount();
    }
  });
});
