import { act, renderHook, waitFor } from '@testing-library/react';
import { createAuthClient } from 'better-auth/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSignIn } from './useSignIn';

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSearchParamsGet = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockMessageError = vi.hoisted(() => vi.fn());
const mockMessageSuccess = vi.hoisted(() => vi.fn());
const mockConfirmModal = vi.hoisted(() => vi.fn());
const mockSignInOauth2 = vi.hoisted(() => vi.fn());
const mockSignInSSO = vi.hoisted(() => vi.fn());
const mockSignInEmail = vi.hoisted(() => vi.fn());
const mockSignInMagicLink = vi.hoisted(() => vi.fn());
const mockRequestPasswordReset = vi.hoisted(() => vi.fn());
const mockBusinessSignin = vi.hoisted(() => ({
  getAdditionalData: vi.fn(async () => ({})),
  preSocialSigninCheck: vi.fn(async () => true),
  managedSSO: false,
  ssoLoaded: true,
  ssoError: false,
  ssoProviders: [] as Array<{
    id: string;
    displayName: string;
    logoUrl: null;
    protocol: 'oidc' | 'oauth2' | 'bridge';
  }>,
}));
const mockLocalStorage = vi.hoisted(() => {
  const store = new Map<string, string>();

  return {
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    removeItem: (key: string) => store.delete(key),
    setItem: (key: string, value: string) => store.set(key, value),
  };
});

vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [{ get: mockSearchParamsGet }],
}));

vi.mock('@lobehub/ui', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confirmModal: mockConfirmModal,
  toast: { error: mockMessageError, success: mockMessageSuccess },
}));

vi.mock('@/libs/better-auth/auth-client', () => ({
  requestPasswordReset: mockRequestPasswordReset,
  signIn: {
    email: mockSignInEmail,
    magicLink: mockSignInMagicLink,
    oauth2: mockSignInOauth2,
    sso: mockSignInSSO,
  },
}));

vi.mock('@/business/client/hooks/useBusinessSignin', () => ({
  useBusinessSignin: () => ({
    ...mockBusinessSignin,
    getAdditionalData: mockBusinessSignin.getAdditionalData,
    preSocialSigninCheck: mockBusinessSignin.preSocialSigninCheck,
    ssoProviders: mockBusinessSignin.ssoProviders,
  }),
}));

let mockEnableBusinessFeatures = false;
let mockEnableMagicLink = false;
let mockDisableEmailPassword = false;
let mockOAuthProviders: string[] = ['google', 'github'];
vi.mock('@/features/AuthShell/AuthServerConfigProvider', () => ({
  useAuthServerConfigStore: (selector: (s: any) => any) =>
    selector({
      serverConfig: {
        disableEmailPassword: mockDisableEmailPassword,
        enableBusinessFeatures: mockEnableBusinessFeatures,
        enableMagicLink: mockEnableMagicLink,
        oAuthSSOProviders: mockOAuthProviders,
      },
      serverConfigInit: true,
    }),
}));

const mockForm = vi.hoisted(() => ({
  getValue: vi.fn(),
  getValues: vi.fn(() => ({ email: 'user@example.com', password: 'stale' })),
  reset: vi.fn(),
  setErrors: vi.fn(),
  setValue: vi.fn(),
  validate: vi.fn(),
}));
vi.mock('@lobehub/ui/form', () => ({
  useForm: () => mockForm,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
vi.stubGlobal('localStorage', mockLocalStorage);

const originalLocation = window.location;

// Exercise the SDK's default redirect plugin rather than mocking its success behavior.
const completeEmailSignInWithSdk = (data: any, options: any) => {
  const client = createAuthClient({
    baseURL: originalLocation.origin,
    fetchOptions: {
      customFetchImpl: async () =>
        Response.json({ redirect: true, token: 'fixture-session', url: data.callbackURL }),
    },
  });
  return client.signIn.email(data, options);
};

describe('useSignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.clear();
    mockSearchParamsGet.mockReturnValue(null);
    mockEnableBusinessFeatures = false;
    mockEnableMagicLink = false;
    mockDisableEmailPassword = false;
    mockOAuthProviders = ['google', 'github'];
    mockBusinessSignin.ssoProviders = [];
    mockBusinessSignin.managedSSO = false;
    mockBusinessSignin.ssoLoaded = true;
    mockBusinessSignin.ssoError = false;
    mockBusinessSignin.getAdditionalData.mockResolvedValue({});
    mockBusinessSignin.preSocialSigninCheck.mockResolvedValue(true);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: '', origin: originalLocation.origin },
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('should return initial values', () => {
      const { result } = renderHook(() => useSignIn());

      expect(result.current.step).toBe('email');
      expect(result.current.email).toBe('');
      expect(result.current.loading).toBe(false);
      expect(result.current.socialLoading).toBeNull();
      expect(result.current.isSocialOnly).toBe(false);
      expect(result.current.disableEmailPassword).toBe(false);
    });
  });

  describe('desktop authorization', () => {
    const callbackFor = (callbackUrl: string | null) =>
      mockSearchParamsGet.mockImplementation((key: string) =>
        key === 'callbackUrl' ? callbackUrl : null,
      );

    it('is recognised from a callback that is the desktop authorization request', () => {
      callbackFor('https://app.example.com/t/acme/oidc/auth?client_id=tituwork-desktop&x=1');

      const { result } = renderHook(() => useSignIn());

      expect(result.current.desktopAuth).toBe(true);
    });

    it.each([
      ['another client', 'https://app.example.com/oidc/auth?client_id=lobehub-mobile'],
      ['a plain page', '/agent'],
      ['no callback', null],
    ])('is not set for %s', (_, callbackUrl) => {
      callbackFor(callbackUrl);

      const { result } = renderHook(() => useSignIn());

      expect(result.current.desktopAuth).toBe(false);
    });
  });

  describe('email prefill from the organization lookup', () => {
    it('fills the email field from ?email= without leaving the email step', () => {
      mockSearchParamsGet.mockImplementation((key: string) =>
        key === 'email' ? 'member@example.com' : null,
      );

      const { result } = renderHook(() => useSignIn());

      expect(mockForm.setValue).toHaveBeenCalledWith('email', 'member@example.com');
      // Prefilling is a convenience; it must not skip the step that offers SSO.
      expect(result.current.step).toBe('email');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('leaves the field alone when no ?email= is present', () => {
      renderHook(() => useSignIn());

      expect(mockForm.setValue).not.toHaveBeenCalled();
    });

    describe('continuing by itself', () => {
      const AGREEMENT_KEY = 'lobehub:auth:agreement-accepted:v1';
      const checkUserCalls = () =>
        mockFetch.mock.calls.filter(([url]) => url === '/api/auth/check-user');
      const arrive = (email: string | null = 'member@example.com') => {
        mockSearchParamsGet.mockImplementation((key: string) => (key === 'email' ? email : null));
        // The field holds what the URL prefilled until the user changes it.
        mockForm.getValue.mockImplementation(() => email ?? '');
      };
      const continueButton = () => {
        const button = document.createElement('button');
        document.body.append(button);
        return button;
      };

      beforeEach(() => {
        mockOAuthProviders = [];
        localStorage.setItem(AGREEMENT_KEY, 'true');
        mockFetch.mockResolvedValue({
          json: async () => ({ exists: true, hasPassword: true }),
          ok: true,
        });
      });

      afterEach(() => document.body.replaceChildren());

      it('runs the same check as clicking Continue when the organization offers no SSO', async () => {
        arrive();

        const { result } = renderHook(() => useSignIn());

        await waitFor(() => expect(result.current.step).toBe('password'));
        expect(checkUserCalls()).toHaveLength(1);
        expect(JSON.parse(checkUserCalls()[0][1].body)).toEqual({ email: 'member@example.com' });
        expect(result.current.email).toBe('member@example.com');
      });

      it('does it once: coming back to the email step does not repeat it', async () => {
        arrive();
        const { result, rerender } = renderHook(() => useSignIn());
        await waitFor(() => expect(result.current.step).toBe('password'));

        act(() => result.current.handleBackToEmail());
        rerender();

        expect(result.current.step).toBe('email');
        expect(checkUserCalls()).toHaveLength(1);
      });

      it('stops on the email step with the usual error when the check fails', async () => {
        arrive();
        mockFetch.mockResolvedValue({ json: async () => ({}), ok: false });

        const { result } = renderHook(() => useSignIn());

        await waitFor(() =>
          expect(mockMessageError).toHaveBeenCalledWith('betterAuth.signin.error'),
        );
        expect(result.current.step).toBe('email');
        expect(checkUserCalls()).toHaveLength(1);
      });

      it('only prefills and focuses Continue when SSO providers are offered', async () => {
        mockOAuthProviders = ['google'];
        arrive();
        mockBusinessSignin.ssoLoaded = false;
        const { result, rerender } = renderHook(() => useSignIn());
        const button = continueButton();
        result.current.continueButtonRef.current = button;

        mockBusinessSignin.ssoLoaded = true;
        rerender();

        await waitFor(() => expect(document.activeElement).toBe(button));
        expect(mockForm.setValue).toHaveBeenCalledWith('email', 'member@example.com');
        expect(checkUserCalls()).toHaveLength(0);
        expect(result.current.step).toBe('email');
      });

      it('drops the auto-continue when the user edits the email while SSO config loads', async () => {
        arrive();
        mockBusinessSignin.ssoLoaded = false;
        const { result, rerender } = renderHook(() => useSignIn());
        const button = continueButton();
        result.current.continueButtonRef.current = button;

        // Typed over the prefilled address before the configuration came back.
        mockForm.getValue.mockImplementation(() => 'other@example.com');
        mockBusinessSignin.ssoLoaded = true;
        rerender();
        await act(async () => {});

        expect(checkUserCalls()).toHaveLength(0);
        expect(document.activeElement).not.toBe(button);
        expect(result.current.step).toBe('email');
      });

      it('does not race a manual submit that is already in flight', async () => {
        arrive();
        mockBusinessSignin.ssoLoaded = false;
        let finishManual!: (value: unknown) => void;
        mockFetch.mockReturnValueOnce(new Promise((resolve) => (finishManual = resolve)));
        const { result, rerender } = renderHook(() => useSignIn());

        let manual!: Promise<void>;
        act(() => {
          manual = result.current.handleCheckUser({ email: 'typed@example.com' });
        });
        mockBusinessSignin.ssoLoaded = true;
        rerender();
        await act(async () => {});

        // Only the user's own submission exists; the URL's address was never sent.
        expect(checkUserCalls()).toHaveLength(1);
        expect(JSON.parse(checkUserCalls()[0][1].body)).toEqual({ email: 'typed@example.com' });

        await act(async () => {
          finishManual({ json: async () => ({ exists: true, hasPassword: true }), ok: true });
          await manual;
        });
        expect(result.current.email).toBe('typed@example.com');
      });

      it('waits for the SSO configuration before deciding anything', async () => {
        arrive();
        mockBusinessSignin.ssoLoaded = false;

        const { result } = renderHook(() => useSignIn());
        await act(async () => {});

        expect(checkUserCalls()).toHaveLength(0);
        expect(result.current.step).toBe('email');
      });

      it('asks for the terms by itself when they are not accepted on this origin, then continues', async () => {
        arrive();
        localStorage.removeItem(AGREEMENT_KEY);
        const { result } = renderHook(() => useSignIn());

        // Nothing is checked or remembered before the user agrees (or if they cancel).
        await waitFor(() => expect(mockConfirmModal).toHaveBeenCalledOnce());
        expect(checkUserCalls()).toHaveLength(0);
        expect(localStorage.getItem(AGREEMENT_KEY)).toBeNull();

        act(() => mockConfirmModal.mock.calls[0][0].onOk());
        await waitFor(() => expect(result.current.step).toBe('password'));
        expect(checkUserCalls()).toHaveLength(1);
        expect(localStorage.getItem(AGREEMENT_KEY)).toBe('true');
      });

      it.each([
        ['an invalid email', () => arrive('not-an-email')],
        ['no email', () => arrive(null)],
        [
          'email sign-in turned off',
          () => {
            arrive();
            mockDisableEmailPassword = true;
          },
        ],
        [
          'a closed organization',
          () => {
            arrive();
            (mockBusinessSignin as { tenantUnavailable?: boolean }).tenantUnavailable = true;
          },
        ],
      ])('does nothing with %s', async (_, arrange) => {
        arrange();

        const { result } = renderHook(() => useSignIn());
        await act(async () => {});

        expect(checkUserCalls()).toHaveLength(0);
        expect(result.current.step).toBe('email');
        delete (mockBusinessSignin as { tenantUnavailable?: boolean }).tenantUnavailable;
      });
    });
  });

  describe('handleCheckUser', () => {
    it('should redirect to signup when user does not exist', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: false }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'new@example.com' });
      });

      expect(mockNavigate).toHaveBeenCalledWith(
        expect.stringContaining('/signup?email=new%40example.com'),
      );
    });

    it('should go to password step when user exists with password', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      expect(result.current.step).toBe('password');
      expect(result.current.email).toBe('user@example.com');
    });

    it('should resolve username to email before checking', async () => {
      // First call: resolve-username
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ email: 'resolved@example.com', exists: true }),
          ok: true,
        })
        // Second call: check-user
        .mockResolvedValueOnce({
          json: async () => ({ exists: true, hasPassword: true }),
          ok: true,
        });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'myusername' });
      });

      expect(mockFetch).toHaveBeenCalledWith('/api/auth/resolve-username', expect.any(Object));
      expect(result.current.step).toBe('password');
      expect(result.current.email).toBe('resolved@example.com');
    });

    it('should show error for unregistered username', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: false }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'unknownuser' });
      });

      expect(mockMessageError).toHaveBeenCalled();
      expect(result.current.step).toBe('email');
    });

    it('should show error for invalid identifier', async () => {
      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'invalid email!@#' });
      });

      expect(mockMessageError).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('handleSignIn', () => {
    it('performs one full-page tenant redirect when the SDK handles a successful login', async () => {
      const navigate = vi.fn();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: {
          ...originalLocation,
          get href() {
            return `${originalLocation.origin}/t/acme/signin`;
          },
          set href(value: string) {
            navigate(value);
          },
          origin: originalLocation.origin,
          pathname: '/t/acme/signin',
        },
      });
      mockSearchParamsGet.mockImplementation((key: string) =>
        key === 'callbackUrl' ? '/t/acme' : null,
      );
      mockSignInEmail.mockImplementation(completeEmailSignInWithSdk);
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });
      const { result } = renderHook(() => useSignIn());
      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });
      await act(async () => {
        await result.current.handleSignIn({ password: 'password123' });
      });
      expect(navigate).toHaveBeenCalledExactlyOnceWith(`${originalLocation.origin}/t/acme`);
    });

    it('should call signIn.email and redirect on success', async () => {
      mockSignInEmail.mockImplementation(completeEmailSignInWithSdk);

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      // Set email first via handleCheckUser
      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      await act(async () => {
        await result.current.handleSignIn({ password: 'password123' });
      });

      expect(mockSignInEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${originalLocation.origin}/`,
          email: 'user@example.com',
          password: 'password123',
        }),
        expect.any(Object),
      );
      expect(window.location.href).toBe(`${originalLocation.origin}/`);
    });

    it.each(['javascript:alert(1)', 'https://evil.com', '//evil.com'])(
      'should fall back to "/" instead of redirecting to hostile callbackUrl %s',
      async (hostileUrl) => {
        mockSearchParamsGet.mockImplementation((key: string) =>
          key === 'callbackUrl' ? hostileUrl : null,
        );
        mockSignInEmail.mockImplementation(completeEmailSignInWithSdk);
        mockFetch.mockResolvedValueOnce({
          json: async () => ({ exists: true, hasPassword: true }),
          ok: true,
        });

        const { result } = renderHook(() => useSignIn());

        await act(async () => {
          await result.current.handleCheckUser({ email: 'user@example.com' });
        });

        await act(async () => {
          await result.current.handleSignIn({ password: 'password123' });
        });

        expect(window.location.href).toBe(`${originalLocation.origin}/`);
      },
    );

    it('should surface sign in failure as an inline password error', async () => {
      mockSignInEmail.mockResolvedValue({
        error: { message: 'Invalid credentials', status: 401 },
      });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      await act(async () => {
        await result.current.handleSignIn({ password: 'wrong' });
      });

      // Error is pinned inline on the password field, not shown as a toast
      expect(mockForm.setErrors).toHaveBeenCalledWith({ password: 'Invalid credentials' });
      expect(mockMessageError).not.toHaveBeenCalled();
    });

    it('should redirect to verify-email on 403', async () => {
      mockSignInEmail.mockImplementation(async (_data: any, opts: any) => {
        opts.onError({ error: { status: 403 } });
        return { error: { message: 'Email not verified', status: 403 } };
      });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      await act(async () => {
        await result.current.handleSignIn({ password: 'password' });
      });

      expect(mockNavigate).toHaveBeenCalledWith(
        expect.stringContaining('/verify-email?email=user%40example.com'),
      );
    });
  });

  describe('tenant unavailable', () => {
    it('explains an unavailable workspace instead of sending a user to sign up', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ code: 'TENANT_FROZEN', reasons: ['manual'] }),
        ok: false,
        status: 403,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockMessageError).toHaveBeenCalledWith('tenant.unavailable.description');
      expect(result.current.step).toBe('email');
    });

    it('does not send a frozen workspace sign-in to email verification', async () => {
      mockSignInEmail.mockImplementation(async (_data: any, opts: any) => {
        opts.onError({ error: { code: 'TENANT_FROZEN', status: 403 } });
        return { error: { code: 'TENANT_FROZEN', status: 403 } };
      });
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });
      await act(async () => {
        await result.current.handleSignIn({ password: 'password' });
      });

      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockMessageError).toHaveBeenCalledWith('tenant.unavailable.description');
    });
  });

  describe('handleSocialSignIn', () => {
    it('should bind relative OAuth callbacks to the current auth origin', async () => {
      const authOrigin = 'https://auth.example.com';
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...originalLocation, href: `${authOrigin}/signin`, origin: authOrigin },
        writable: true,
      });
      mockSearchParamsGet.mockImplementation((key: string) =>
        key === 'callbackUrl' ? '/workspace?tab=members' : null,
      );
      mockSignInOauth2.mockResolvedValue({ url: 'https://google.com/auth' });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('google');
      });

      expect(mockSignInOauth2).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${authOrigin}/workspace?tab=members`,
          newUserCallbackURL: `${authOrigin}/onboarding?callbackUrl=%2Fworkspace%3Ftab%3Dmembers`,
        }),
      );
    });

    it.each(['google', 'github', 'apple', 'microsoft', 'microsoft-entra-id', 'cognito'])(
      'should sign in a tenant provider named %s through signIn.oauth2, never signIn.social',
      async (providerId) => {
        mockSignInOauth2.mockResolvedValue({ url: 'https://google.com/auth' });

        const { result } = renderHook(() => useSignIn());

        await act(async () => {
          await result.current.handleSocialSignIn(providerId);
        });

        expect(mockSignInOauth2).toHaveBeenCalledWith(
          expect.objectContaining({
            newUserCallbackURL: `${originalLocation.origin}/onboarding`,
            providerId,
          }),
        );
        expect(mockMessageError).not.toHaveBeenCalled();
      },
    );

    it('should call signIn.oauth2 for custom providers', async () => {
      mockSignInOauth2.mockResolvedValue({ url: 'https://custom.com/auth' });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('custom-oidc');
      });

      expect(mockSignInOauth2).toHaveBeenCalledWith(
        expect.objectContaining({
          newUserCallbackURL: `${originalLocation.origin}/onboarding`,
          providerId: 'custom-oidc',
        }),
      );
    });

    it('should preserve a mobile app callback scheme', async () => {
      const mobileCallbackUrl = 'com.lobehub.app:///auth/callback';
      mockSearchParamsGet.mockImplementation((key: string) =>
        key === 'callbackUrl' ? mobileCallbackUrl : null,
      );
      mockSignInOauth2.mockResolvedValue({ url: 'https://google.com/auth' });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('google');
      });

      expect(mockSignInOauth2).toHaveBeenCalledWith(
        expect.objectContaining({ callbackURL: mobileCallbackUrl }),
      );
    });

    it('should NOT throw when result has error: null (redirect case)', async () => {
      mockSignInOauth2.mockResolvedValue({
        error: null,
        redirect: true,
        url: 'https://google.com/auth',
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('google');
      });

      // Should not show error toast — this is the critical regression test
      expect(mockMessageError).not.toHaveBeenCalled();
    });

    it('should show error when result has a real error', async () => {
      mockSignInOauth2.mockResolvedValue({
        error: { message: 'OAuth failed', status: 500 },
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('google');
      });

      expect(mockMessageError).toHaveBeenCalled();
    });

    it('should not retry social sign in when captcha is returned unexpectedly', async () => {
      mockSignInOauth2.mockResolvedValue({
        error: { code: 'CAPTCHA_REQUIRED', message: 'Missing CAPTCHA response', status: 400 },
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('google');
      });

      expect(mockSignInOauth2).toHaveBeenCalledTimes(1);
      expect(mockMessageError).toHaveBeenCalled();
    });

    it('should save last auth provider to localStorage', async () => {
      mockSignInOauth2.mockResolvedValue({ url: 'https://google.com/auth' });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('google');
      });

      expect(localStorage.getItem('lobehub:auth:last-provider:v1')).toBe('google');
    });

    it('should stop social sign in when business pre-check rejects', async () => {
      mockEnableBusinessFeatures = true;
      mockBusinessSignin.preSocialSigninCheck.mockResolvedValue(false);

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('google');
      });

      expect(mockBusinessSignin.preSocialSigninCheck).toHaveBeenCalled();
      expect(mockSignInOauth2).not.toHaveBeenCalled();
    });
  });

  describe('handleBackToEmail', () => {
    it('should reset to email step', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      expect(result.current.step).toBe('password');

      act(() => {
        result.current.handleBackToEmail();
      });

      expect(result.current.step).toBe('email');
      expect(result.current.email).toBe('');
      expect(result.current.isSocialOnly).toBe(false);
      // The shared form's password (+ any inline error) must be cleared so the
      // next email doesn't remount pre-filled with the previous account's value.
      expect(mockForm.reset).toHaveBeenCalledWith({ email: 'user@example.com', password: '' });
    });
  });

  describe('handleForgotPassword', () => {
    it('should call requestPasswordReset and land on the email-sent state', async () => {
      mockRequestPasswordReset.mockResolvedValue({ data: { status: true }, error: null });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      // Set email first
      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      await act(async () => {
        await result.current.handleForgotPassword();
      });

      expect(mockRequestPasswordReset).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'user@example.com',
          redirectTo: `${originalLocation.origin}/reset-password?email=user%40example.com`,
        }),
      );
      // Success is a persistent landing state, not a fleeting toast
      expect(result.current.step).toBe('emailSent');
      expect(result.current.sentInfo).toEqual(
        expect.objectContaining({ email: 'user@example.com', type: 'resetPassword' }),
      );
    });

    it('should no-op when no email has been resolved yet', async () => {
      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleForgotPassword();
      });

      expect(mockRequestPasswordReset).not.toHaveBeenCalled();
      expect(result.current.step).toBe('email');
    });

    // The better-auth client resolves with `{ data, error }` rather than
    // throwing, so a rejected-promise test alone leaves the failure branch
    // unreachable and a failed send lands on the "email sent" screen.
    it('should show error and stay put when the client resolves with an error', async () => {
      mockRequestPasswordReset.mockResolvedValue({
        data: null,
        error: { message: 'Email provider rejected the request', status: 503 },
      });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      await act(async () => {
        await result.current.handleForgotPassword();
      });

      expect(mockMessageError).toHaveBeenCalled();
      expect(result.current.step).toBe('password');
      expect(result.current.sentInfo).toBeNull();
    });

    it('should show error on failure', async () => {
      mockRequestPasswordReset.mockRejectedValue(new Error('fail'));

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      await act(async () => {
        await result.current.handleForgotPassword();
      });

      expect(mockMessageError).toHaveBeenCalled();
      expect(result.current.step).toBe('password');
    });
  });

  describe('magic link', () => {
    it('should land on email-sent state when a passwordless user triggers magic link', async () => {
      mockEnableMagicLink = true;
      mockSignInMagicLink.mockResolvedValue({ error: null });
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: false }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      expect(mockSignInMagicLink).toHaveBeenCalledTimes(1);
      expect(mockSignInMagicLink).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${originalLocation.origin}/`,
          newUserCallbackURL: `${originalLocation.origin}/onboarding`,
        }),
      );
      expect(result.current.step).toBe('emailSent');
      expect(result.current.sentInfo).toEqual(
        expect.objectContaining({ email: 'user@example.com', type: 'magicLink' }),
      );
    });
  });

  describe('handleResendEmail', () => {
    it('should resend the password reset email and confirm', async () => {
      mockRequestPasswordReset.mockResolvedValue({ data: { status: true }, error: null });
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });
      await act(async () => {
        await result.current.handleForgotPassword();
      });

      mockRequestPasswordReset.mockClear();

      await act(async () => {
        await result.current.handleResendEmail();
      });

      expect(mockRequestPasswordReset).toHaveBeenCalledTimes(1);
      expect(mockMessageSuccess).toHaveBeenCalled();
      expect(result.current.step).toBe('emailSent');
    });
  });

  describe('handleBackFromSent', () => {
    it('should return to the email entry (not the password step) after a reset email', async () => {
      mockRequestPasswordReset.mockResolvedValue({ data: { status: true }, error: null });
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });
      await act(async () => {
        await result.current.handleForgotPassword();
      });

      expect(result.current.step).toBe('emailSent');

      act(() => {
        result.current.handleBackFromSent();
      });

      // "Use a different email" must land on the email entry so the label
      // matches the action, and reset the shared password field.
      expect(result.current.step).toBe('email');
      expect(result.current.email).toBe('');
      expect(result.current.sentInfo).toBeNull();
      expect(mockForm.reset).toHaveBeenCalledWith({ email: 'user@example.com', password: '' });
    });
  });

  describe('enabled email login methods', () => {
    it.each([true, false])(
      'uses magic link when password is disabled (hasPassword=%s)',
      async (hasPassword) => {
        mockDisableEmailPassword = true;
        mockEnableMagicLink = true;
        mockSignInMagicLink.mockResolvedValue({ error: null });
        mockFetch.mockResolvedValueOnce({
          json: async () => ({ exists: true, hasPassword }),
          ok: true,
        });
        const { result } = renderHook(() => useSignIn());
        await act(async () => {
          await result.current.handleCheckUser({ email: 'user@example.com' });
        });
        expect(mockSignInMagicLink).toHaveBeenCalledWith(
          expect.objectContaining({ email: 'user@example.com' }),
        );
        expect(mockSignInEmail).not.toHaveBeenCalled();
        expect(result.current.step).toBe('emailSent');
      },
    );

    it('sends unknown email through magic-link admission instead of disabled signup', async () => {
      mockDisableEmailPassword = true;
      mockEnableMagicLink = true;
      mockSignInMagicLink.mockResolvedValue({ error: null });
      mockFetch.mockResolvedValueOnce({ json: async () => ({ exists: false }), ok: true });
      const { result } = renderHook(() => useSignIn());
      await act(async () => {
        await result.current.handleCheckUser({ email: 'new@example.com' });
      });
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockSignInMagicLink).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'new@example.com' }),
      );
      expect(result.current.step).toBe('emailSent');
    });

    it('keeps a denied magic-link admission on email entry for retry', async () => {
      mockDisableEmailPassword = true;
      mockEnableMagicLink = true;
      mockSignInMagicLink.mockResolvedValue({ error: { message: 'Registration closed' } });
      mockFetch.mockResolvedValueOnce({ json: async () => ({ exists: false }), ok: true });
      const { result } = renderHook(() => useSignIn());
      await act(async () => {
        await result.current.handleCheckUser({ email: 'new@example.com' });
      });
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockMessageError).toHaveBeenCalledWith('Registration closed');
      expect(result.current.step).toBe('email');
      expect(result.current.sentInfo).toBeNull();
    });

    it('makes no email credential request when both email methods are disabled', async () => {
      mockDisableEmailPassword = true;
      const { result } = renderHook(() => useSignIn());
      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
        await result.current.handleSignIn({ password: 'fixture-password' });
        result.current.handleGoToSignup();
      });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockSignInEmail).not.toHaveBeenCalled();
      expect(mockSignInMagicLink).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(result.current.step).toBe('email');
    });

    it('does not reset passwords after the password method is disabled', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });
      const { result, rerender } = renderHook(() => useSignIn());
      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });
      mockDisableEmailPassword = true;
      rerender();
      await act(async () => {
        await result.current.handleForgotPassword();
      });
      expect(mockRequestPasswordReset).not.toHaveBeenCalled();
      expect(result.current.sentInfo).toBeNull();
    });

    it('does not resend a magic link after that method is disabled', async () => {
      mockEnableMagicLink = true;
      mockSignInMagicLink.mockResolvedValue({ error: null });
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: false }),
        ok: true,
      });
      const { result, rerender } = renderHook(() => useSignIn());
      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });
      mockEnableMagicLink = false;
      rerender();
      mockSignInMagicLink.mockClear();
      await act(async () => {
        await result.current.handleResendEmail();
      });
      expect(mockSignInMagicLink).not.toHaveBeenCalled();
      expect(mockMessageSuccess).not.toHaveBeenCalled();
    });
  });

  describe('provider sorting', () => {
    it('should sort last used provider first', () => {
      localStorage.setItem('lobehub:auth:last-provider:v1', 'github');

      const { result } = renderHook(() => useSignIn());

      expect(result.current.oAuthSSOProviders[0]).toBe('github');

      localStorage.removeItem('lobehub:auth:last-provider:v1');
    });

    it('keeps tenant OAuth providers alongside the Bridge provider', () => {
      mockBusinessSignin.ssoProviders = [
        { id: 'bridge-id', displayName: 'Bridge', logoUrl: null, protocol: 'bridge' },
      ];
      const { result } = renderHook(() => useSignIn());
      expect(result.current.oAuthSSOProviders).toEqual(['google', 'github', 'bridge-id']);
    });

    it('uses managed provider IDs instead of environment providers', () => {
      mockBusinessSignin.managedSSO = true;
      mockBusinessSignin.ssoProviders = [
        { id: 'managed-id', displayName: 'Company', logoUrl: null, protocol: 'oidc' },
      ];

      const { result } = renderHook(() => useSignIn());

      expect(result.current.oAuthSSOProviders).toEqual(['managed-id']);
    });

    it('does not expose environment providers when configuration fails to load', () => {
      mockBusinessSignin.ssoLoaded = false;
      mockBusinessSignin.ssoError = true;
      const { result } = renderHook(() => useSignIn());
      expect(result.current.oAuthSSOProviders).toEqual([]);
      expect(result.current.ssoError).toBe(true);
    });

    it.each(['oidc', 'oauth2'] as const)(
      'dispatches managed %s by UUID while preserving onboarding redirects',
      async (protocol) => {
        mockBusinessSignin.managedSSO = true;
        mockBusinessSignin.ssoProviders = [
          { id: 'managed-id', displayName: 'Company', logoUrl: null, protocol },
        ];
        const { result } = renderHook(() => useSignIn());
        await act(async () => {
          await result.current.handleSocialSignIn('managed-id');
        });
        const handler = protocol === 'oidc' ? mockSignInSSO : mockSignInOauth2;
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            callbackURL: expect.any(String),
            newUserCallbackURL: expect.stringContaining('onboarding'),
            providerId: 'managed-id',
          }),
        );
      },
    );
  });
});
