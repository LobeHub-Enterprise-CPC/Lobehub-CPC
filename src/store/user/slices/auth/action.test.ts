import { initializeTenant } from '@lobechat/business-tenant/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mutate } from '@/libs/swr';
import { useUserStore } from '@/store/user';
import { readUserDisplaySnapshot, writeUserDisplaySnapshot } from '@/store/user/displaySnapshot';

// Mock @/libs/swr mutate
vi.mock('@/libs/swr', async () => {
  const actual = await vi.importActual('@/libs/swr');
  return {
    ...actual,
    mutate: vi.fn(),
  };
});

const mockBetterAuthClient = vi.hoisted(() => ({
  listAccounts: vi.fn().mockResolvedValue({ data: [] }),
  accountInfo: vi.fn().mockResolvedValue({ data: { user: {} } }),
  signOut: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/libs/better-auth/auth-client', () => mockBetterAuthClient);

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  initializeTenant(new URL('http://localhost/'));

  // Reset store state
  useUserStore.setState({
    isSigningOut: false,
    isLoadedAuthProviders: false,
    authProviders: [],
    hasPasswordAccount: false,
  });
});

describe('createAuthSlice', () => {
  describe('refreshUserState', () => {
    it('should refresh user config', async () => {
      const { result } = renderHook(() => useUserStore());

      await act(async () => {
        await result.current.refreshUserState();
      });

      // The bootstrap payload now lives in a replica resource: a refresh
      // re-mutates the cache through the replica driver's key predicate.
      expect(mutate).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  it.each(['logout', 'openLogin'] as const)('keeps the tenant on %s redirects', async (action) => {
    // The page's tenant context, as the app entry initializes it at boot.
    initializeTenant(new URL('http://localhost/t/acme/agent'));
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        href: '',
        pathname: '/t/acme/agent',
        toString: () => 'http://localhost/t/acme/agent',
      },
      writable: true,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    mockBetterAuthClient.signOut.mockImplementationOnce(async ({ fetchOptions }) => {
      fetchOptions?.onSuccess?.();
    });
    try {
      await act(async () => {
        await useUserStore.getState()[action]();
      });
      expect(window.location.href).toMatch(/^\/t\/acme\/signin(?:\?|$)/);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
        writable: true,
      });
      mockBetterAuthClient.signOut.mockReset().mockResolvedValue({});
    }
  });

  describe('logout', () => {
    it('shares an in-progress sign-out and retains its original tenant redirect', async () => {
      initializeTenant(new URL('http://localhost/t/acme/agent'));
      let resolveCleanup!: (response: Response) => void;
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveCleanup = resolve;
          }),
      );
      const originalLocation = window.location;
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { href: '', pathname: '/t/acme/agent' },
        writable: true,
      });
      mockBetterAuthClient.signOut.mockImplementationOnce(async ({ fetchOptions }) => {
        fetchOptions.onSuccess();
      });
      try {
        const first = useUserStore.getState().logout();
        const second = useUserStore
          .getState()
          .logout({ redirectTo: '/signin?reason=sessionExpired' });
        const isSigningOut = useUserStore.getState().isSigningOut;
        resolveCleanup(new Response(null));
        await Promise.all([first, second]);

        expect(isSigningOut).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(mockBetterAuthClient.signOut).toHaveBeenCalledTimes(1);
        expect(window.location.href).toBe('/t/acme/signin');
      } finally {
        Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
      }
    });
    it('clears the captured user snapshot after successful sign-out', async () => {
      writeUserDisplaySnapshot('user-a', { avatar: 'avatar-a' });
      writeUserDisplaySnapshot('user-b', { avatar: 'avatar-b' });
      localStorage.setItem('lobehub:active-scope', 'user-a:personal');
      useUserStore.setState({ user: { id: 'user-a' } });

      mockBetterAuthClient.signOut.mockImplementationOnce(async ({ fetchOptions }) => {
        // A concurrent session update must not change which snapshot this
        // sign-out is allowed to clear.
        useUserStore.setState({ user: { id: 'user-b' } });
        fetchOptions?.onSuccess?.();
      });

      const { result } = renderHook(() => useUserStore());

      await act(async () => {
        await result.current.logout();
      });

      expect(mockBetterAuthClient.signOut).toHaveBeenCalled();
      expect(readUserDisplaySnapshot('user-a')).toBeUndefined();
      expect(readUserDisplaySnapshot('user-b')).toEqual({ avatar: 'avatar-b' });
      expect(localStorage.getItem('lobehub:active-scope')).toBeNull();
    });

    it('preserves the signing-out user snapshot when sign-out fails', async () => {
      writeUserDisplaySnapshot('user-a', { avatar: 'avatar-a' });
      localStorage.setItem('lobehub:active-scope', 'user-a:personal');
      useUserStore.setState({ user: { id: 'user-a' } });
      mockBetterAuthClient.signOut.mockRejectedValueOnce(new Error('sign-out failed'));

      const { result } = renderHook(() => useUserStore());
      const logoutPromise = result.current.logout();

      await expect(logoutPromise).rejects.toThrow('sign-out failed');

      expect(useUserStore.getState().isSigningOut).toBe(false);

      expect(readUserDisplaySnapshot('user-a')).toEqual({ avatar: 'avatar-a' });
      expect(localStorage.getItem('lobehub:active-scope')).toBe('user-a:personal');
    });
  });

  describe('openLogin', () => {
    it('should redirect to signin page', async () => {
      const originalLocation = window.location;
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: {
          ...originalLocation,
          href: '',
          pathname: '/chat',
          toString: () => 'http://localhost/chat',
        },
        writable: true,
      });

      const { result } = renderHook(() => useUserStore());

      await act(async () => {
        await result.current.openLogin();
      });

      expect(window.location.href).toContain('/signin');
      expect(window.location.href).toContain('callbackUrl');

      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
        writable: true,
      });
    });

    it('should explain an expired session on the signin page', async () => {
      const originalLocation = window.location;
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: {
          ...originalLocation,
          href: '',
          pathname: '/chat',
          toString: () => 'http://localhost/chat',
        },
        writable: true,
      });

      const { result } = renderHook(() => useUserStore());

      await act(async () => {
        await result.current.openLogin('sessionExpired');
      });

      expect(window.location.href).toContain('reason=sessionExpired');

      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
        writable: true,
      });
    });

    it('should not redirect when already on signin page', async () => {
      const originalLocation = window.location;
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: {
          ...originalLocation,
          href: '',
          pathname: '/signin',
          toString: () => 'http://localhost/signin',
        },
        writable: true,
      });

      const { result } = renderHook(() => useUserStore());

      await act(async () => {
        await result.current.openLogin();
      });

      expect(window.location.href).toBe('');

      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
        writable: true,
      });
    });
  });

  describe('fetchAuthProviders', () => {
    it('should skip fetching if already loaded', async () => {
      useUserStore.setState({ isLoadedAuthProviders: true });

      const { result } = renderHook(() => useUserStore());

      await act(async () => {
        await result.current.fetchAuthProviders();
      });

      expect(mockBetterAuthClient.listAccounts).not.toHaveBeenCalled();
    });

    it('should fetch providers from BetterAuth', async () => {
      mockBetterAuthClient.listAccounts.mockResolvedValueOnce({
        data: [
          { providerId: 'github', accountId: 'gh-123' },
          { providerId: 'credential', accountId: 'cred-1' },
        ],
      });
      mockBetterAuthClient.accountInfo.mockResolvedValueOnce({
        data: { user: { email: 'test@github.com' } },
      });

      const { result } = renderHook(() => useUserStore());

      await act(async () => {
        await result.current.fetchAuthProviders();
      });

      expect(mockBetterAuthClient.listAccounts).toHaveBeenCalled();
      expect(result.current.isLoadedAuthProviders).toBe(true);
      expect(result.current.hasPasswordAccount).toBe(true);
    });

    it('should handle fetch error gracefully', async () => {
      mockBetterAuthClient.listAccounts.mockRejectedValueOnce(new Error('Network error'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useUserStore());

      await act(async () => {
        await result.current.fetchAuthProviders();
      });

      expect(result.current.isLoadedAuthProviders).toBe(true);
      consoleSpy.mockRestore();
    });
  });

  describe('refreshAuthProviders', () => {
    it('should refresh providers from BetterAuth', async () => {
      mockBetterAuthClient.listAccounts.mockResolvedValueOnce({
        data: [{ providerId: 'google', accountId: 'g-1' }],
      });
      mockBetterAuthClient.accountInfo.mockResolvedValueOnce({
        data: { user: { email: 'user@gmail.com' } },
      });

      const { result } = renderHook(() => useUserStore());

      await act(async () => {
        await result.current.refreshAuthProviders();
      });

      expect(mockBetterAuthClient.listAccounts).toHaveBeenCalled();
      expect(result.current.authProviders).toEqual([
        { provider: 'google', email: 'user@gmail.com', providerAccountId: 'g-1' },
      ]);
    });

    it('should handle refresh error gracefully', async () => {
      mockBetterAuthClient.listAccounts.mockRejectedValueOnce(new Error('Refresh failed'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useUserStore());

      await act(async () => {
        await result.current.refreshAuthProviders();
      });

      // Should not throw
      consoleSpy.mockRestore();
    });
  });
});
