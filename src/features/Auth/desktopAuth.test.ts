import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DESKTOP_CLIENT_ID,
  interactionUidOf,
  isDesktopAuthorizeCallback,
  isDesktopClientId,
  useDesktopAuthContext,
} from './desktopAuth';

const interaction = vi.hoisted(() => ({
  data: undefined as { clientId: string } | undefined,
  uid: undefined as string | undefined,
}));
vi.mock('./OAuthConsent/useInteractionDetails', () => ({
  useInteractionDetails: (uid?: string) => {
    interaction.uid = uid;
    return { data: uid ? interaction.data : undefined };
  },
}));

const authorize = (clientId: string, prefix = '') =>
  `https://app.example.com${prefix}/oidc/auth?client_id=${clientId}&response_type=code`;

describe('isDesktopClientId', () => {
  it('matches only the desktop client', () => {
    expect(isDesktopClientId(DESKTOP_CLIENT_ID)).toBe(true);
    expect(isDesktopClientId('lobehub-mobile')).toBe(false);
    expect(isDesktopClientId(undefined)).toBe(false);
  });
});

describe('isDesktopAuthorizeCallback', () => {
  it('recognises the desktop authorization request, with or without a tenant prefix', () => {
    expect(isDesktopAuthorizeCallback(authorize('lobehub-desktop'))).toBe(true);
    expect(isDesktopAuthorizeCallback(authorize('lobehub-desktop', '/t/acme'))).toBe(true);
    expect(isDesktopAuthorizeCallback('/oidc/auth?client_id=lobehub-desktop')).toBe(true);
  });

  it.each([
    ['another client', authorize('lobehub-mobile')],
    ['a look-alike path', 'https://app.example.com/other/oidc/author?client_id=lobehub-desktop'],
    [
      'the client id only in another parameter',
      'https://app.example.com/agent?client_id=lobehub-desktop',
    ],
    ['no callback', null],
    ['an empty callback', ''],
  ])('does not treat %s as desktop', (_, callbackUrl) => {
    expect(isDesktopAuthorizeCallback(callbackUrl)).toBe(false);
  });
});

describe('interactionUidOf', () => {
  it('extracts the interaction id of a consent page address', () => {
    expect(interactionUidOf('https://app.example.com/t/acme/oauth/consent/abc123?hl=zh-CN')).toBe(
      'abc123',
    );
    expect(interactionUidOf('/oauth/consent/abc123')).toBe('abc123');
  });

  it('extracts the interaction id of a login-prompt page address, with any tenant prefix', () => {
    expect(interactionUidOf('/oidc/interaction/abc123/login')).toBe('abc123');
    expect(interactionUidOf('/t/acme/oidc/interaction/abc123/login')).toBe('abc123');
    expect(
      interactionUidOf('https://app.example.com/t/acme/oidc/interaction/abc123/login?hl=zh-CN'),
    ).toBe('abc123');
    expect(interactionUidOf('/t/acme/oidc/interaction/abc123/login/')).toBe('abc123');
  });

  it('is null for anything else', () => {
    expect(interactionUidOf('/agent')).toBeNull();
    expect(interactionUidOf('/oidc/interaction/abc123')).toBeNull();
    expect(interactionUidOf('/oidc/interaction/abc123/other')).toBeNull();
    expect(interactionUidOf('/oauth/consent/abc123/other')).toBeNull();
    expect(interactionUidOf(null)).toBeNull();
  });
});

describe('useDesktopAuthContext', () => {
  beforeEach(() => {
    interaction.data = undefined;
    interaction.uid = undefined;
  });

  it('is true from the callback alone, without looking anything up', () => {
    const { result } = renderHook(() => useDesktopAuthContext(authorize('lobehub-desktop')));

    expect(result.current).toBe(true);
    expect(interaction.uid).toBeUndefined();
  });

  it('reads the client from the interaction the callback names', () => {
    interaction.data = { clientId: 'lobehub-desktop' };

    const { result } = renderHook(() =>
      useDesktopAuthContext('https://app.example.com/t/acme/oauth/consent/abc123'),
    );

    expect(interaction.uid).toBe('abc123');
    expect(result.current).toBe(true);
  });

  it('resolves the interaction behind a login-prompt page via the read-only details lookup', () => {
    interaction.data = { clientId: 'lobehub-desktop' };

    const { result } = renderHook(() =>
      useDesktopAuthContext('/t/acme/oidc/interaction/abc123/login'),
    );

    expect(interaction.uid).toBe('abc123');
    expect(result.current).toBe(true);
  });

  it('is false for another client, while loading, and without a callback', () => {
    interaction.data = { clientId: 'lobehub-mobile' };
    expect(renderHook(() => useDesktopAuthContext('/oauth/consent/abc123')).result.current).toBe(
      false,
    );

    interaction.data = undefined;
    expect(renderHook(() => useDesktopAuthContext('/oauth/consent/abc123')).result.current).toBe(
      false,
    );
    expect(renderHook(() => useDesktopAuthContext(null)).result.current).toBe(false);
    expect(interaction.uid).toBeUndefined();
  });
});
