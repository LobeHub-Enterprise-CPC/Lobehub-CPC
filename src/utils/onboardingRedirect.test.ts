import { initializeTenant } from '@lobechat/business-tenant/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildOnboardingRedirectUrl,
  clearStaleOnboardingCallbackUrl,
  consumeOnboardingCallbackUrl,
  isSafeRedirectPath,
  peekOnboardingCallbackUrl,
  resolvePostOnboardingTargetUrl,
  sanitizeRedirectPath,
  stashOnboardingCallbackUrl,
  toAbsoluteAuthCallbackUrl,
} from './onboardingRedirect';

beforeEach(() => {
  sessionStorage.clear();
});

describe('isSafeRedirectPath', () => {
  it('should accept same-site relative paths', () => {
    expect(isSafeRedirectPath('/')).toBe(true);
    expect(isSafeRedirectPath('/agent/abc?message=hi')).toBe(true);
  });

  it('should reject absolute and protocol-relative URLs', () => {
    expect(isSafeRedirectPath('https://evil.com')).toBe(false);
    expect(isSafeRedirectPath('//evil.com')).toBe(false);
    expect(isSafeRedirectPath('javascript:alert(1)')).toBe(false);
  });

  it('should reject backslash paths that browsers normalize to protocol-relative URLs', () => {
    expect(isSafeRedirectPath('/\\evil.com')).toBe(false);
    expect(isSafeRedirectPath('/\\/evil.com')).toBe(false);
    expect(isSafeRedirectPath('/foo\\bar')).toBe(false);
  });
});

describe('toAbsoluteAuthCallbackUrl', () => {
  const authOrigin = 'https://auth.example.com';

  it('should bind safe relative paths to the current auth origin', () => {
    expect(toAbsoluteAuthCallbackUrl('/', authOrigin)).toBe(`${authOrigin}/`);
    expect(toAbsoluteAuthCallbackUrl('/workspace?tab=members', authOrigin)).toBe(
      `${authOrigin}/workspace?tab=members`,
    );
  });

  it.each([
    'https://app.example.com/workspace',
    'com.lobehub.app:///auth/callback',
    '//evil.com/callback',
    '/\\evil.com',
  ])('should preserve non-relative callback %s', (callbackUrl) => {
    expect(toAbsoluteAuthCallbackUrl(callbackUrl, authOrigin)).toBe(callbackUrl);
  });
});

describe('tenant pages', () => {
  const authOrigin = 'https://auth.example.com';

  beforeEach(() => {
    window.history.replaceState(null, '', '/orgs/acme/signin?callbackUrl=%2F');
    initializeTenant(new URL(window.location.href));
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    initializeTenant(new URL(window.location.href));
  });

  it("should send post-login callbacks to the page's tenant, not the bare root", () => {
    expect(toAbsoluteAuthCallbackUrl('/', authOrigin)).toBe(`${authOrigin}/orgs/acme`);
    expect(toAbsoluteAuthCallbackUrl('/onboarding?callbackUrl=%2Fagent', authOrigin)).toBe(
      `${authOrigin}/orgs/acme/onboarding?callbackUrl=%2Fagent`,
    );
    // Already addressed to the tenant: unchanged.
    expect(toAbsoluteAuthCallbackUrl('/orgs/acme/agent', authOrigin)).toBe(
      `${authOrigin}/orgs/acme/agent`,
    );
  });

  it('should keep the tenant on full-page redirects, including the fallback', () => {
    expect(sanitizeRedirectPath(null)).toBe('/orgs/acme');
    expect(sanitizeRedirectPath('/agent/abc')).toBe('/orgs/acme/agent/abc');
    expect(sanitizeRedirectPath('https://evil.com')).toBe('/orgs/acme');
  });

  it('should keep default signup landings within the current tenant', () => {
    expect(buildOnboardingRedirectUrl()).toBe('/orgs/acme/onboarding');
    expect(buildOnboardingRedirectUrl('/')).toBe('/orgs/acme/onboarding');
    expect(buildOnboardingRedirectUrl('/orgs/acme')).toBe('/orgs/acme/onboarding');
  });

  it('should preserve scoped targets without nesting an existing onboarding callback', () => {
    expect(buildOnboardingRedirectUrl('/agent/abc?message=hi')).toBe(
      '/orgs/acme/onboarding?callbackUrl=%2Forgs%2Facme%2Fagent%2Fabc%3Fmessage%3Dhi',
    );
    expect(
      buildOnboardingRedirectUrl(`${window.location.origin}/orgs/acme/onboarding/agent?step=2`),
    ).toBe('/orgs/acme/onboarding/agent?step=2');
  });

  it.each([
    '/orgs/other/agent',
    '/orgs/acme/../other/agent',
    '/orgs/acme/%2e%2e/other/agent',
    '/../../orgs/other/agent',
    '/\n/evil.com',
    'https://evil.com',
  ])('should keep an unsafe or cross-tenant callback %s in the current tenant', (callbackUrl) => {
    expect(sanitizeRedirectPath(callbackUrl)).toBe('/orgs/acme');
    expect(buildOnboardingRedirectUrl(callbackUrl)).toBe('/orgs/acme/onboarding');
    if (isSafeRedirectPath(callbackUrl)) {
      expect(toAbsoluteAuthCallbackUrl(callbackUrl, authOrigin)).toBe(`${authOrigin}/orgs/acme`);
    }
  });

  it('should return router-relative targets after onboarding without repeating its basename', () => {
    stashOnboardingCallbackUrl('?callbackUrl=%2Forgs%2Facme%2Fagent%2Fabc%3Fmessage%3Dhi');
    expect(resolvePostOnboardingTargetUrl()).toBe('/agent/abc?message=hi');
    expect(peekOnboardingCallbackUrl()).toBeUndefined();

    stashOnboardingCallbackUrl('?callbackUrl=%2Forgs%2Facme%3Fonboarding%3Dtask');
    expect(resolvePostOnboardingTargetUrl()).toBe('/?onboarding=task');

    stashOnboardingCallbackUrl('?callbackUrl=%2Ft%2Fother%2Fagent');
    expect(resolvePostOnboardingTargetUrl()).toBe('/');
  });

  it('should clear abandoned callbacks on a fresh scoped entry while keeping step re-entries', () => {
    stashOnboardingCallbackUrl('?callbackUrl=%2Fagent');
    clearStaleOnboardingCallbackUrl('/orgs/acme/onboarding', '?step=2');
    expect(peekOnboardingCallbackUrl()).toBe('/agent');

    clearStaleOnboardingCallbackUrl('/orgs/acme/onboarding', '');
    expect(peekOnboardingCallbackUrl()).toBeUndefined();
  });
});

describe('buildOnboardingRedirectUrl', () => {
  it('should return plain onboarding path for default or missing callbackUrl', () => {
    expect(buildOnboardingRedirectUrl()).toBe('/onboarding');
    expect(buildOnboardingRedirectUrl(null)).toBe('/onboarding');
    expect(buildOnboardingRedirectUrl('/')).toBe('/onboarding');
  });

  it('should thread an explicit target through the callbackUrl query param', () => {
    expect(buildOnboardingRedirectUrl('/agent/abc?message=hi')).toBe(
      '/onboarding?callbackUrl=%2Fagent%2Fabc%3Fmessage%3Dhi',
    );
  });

  it('should not nest when the target is already an onboarding path', () => {
    expect(buildOnboardingRedirectUrl('/onboarding')).toBe('/onboarding');
    expect(buildOnboardingRedirectUrl('/onboarding/agent')).toBe('/onboarding/agent');
  });

  it('should thread similarly named pages through onboarding instead of bypassing it', () => {
    expect(buildOnboardingRedirectUrl('/onboarding-history')).toBe(
      '/onboarding?callbackUrl=%2Fonboarding-history',
    );
  });

  it('should drop unsafe external targets', () => {
    expect(buildOnboardingRedirectUrl('https://evil.com')).toBe('/onboarding');
    expect(buildOnboardingRedirectUrl('//evil.com')).toBe('/onboarding');
    expect(buildOnboardingRedirectUrl('/\\evil.com')).toBe('/onboarding');
  });

  it('should normalize same-origin absolute URLs to relative paths', () => {
    const origin = window.location.origin;
    expect(buildOnboardingRedirectUrl(`${origin}/settings?tab=profile`)).toBe(
      '/onboarding?callbackUrl=%2Fsettings%3Ftab%3Dprofile',
    );
    expect(buildOnboardingRedirectUrl(`${origin}/`)).toBe('/onboarding');
    expect(buildOnboardingRedirectUrl(`${origin}/onboarding/agent`)).toBe('/onboarding/agent');
  });
});

describe('stash/peek/consumeOnboardingCallbackUrl', () => {
  it('should stash the callbackUrl from a location search string', () => {
    stashOnboardingCallbackUrl('?callbackUrl=%2Fagent%2Fabc%3Fmessage%3Dhi');

    expect(peekOnboardingCallbackUrl()).toBe('/agent/abc?message=hi');
  });

  it('should keep the stashed value across peeks and clear it on consume', () => {
    stashOnboardingCallbackUrl('?callbackUrl=%2Fdiscover');

    expect(peekOnboardingCallbackUrl()).toBe('/discover');
    expect(consumeOnboardingCallbackUrl()).toBe('/discover');
    expect(peekOnboardingCallbackUrl()).toBeUndefined();
    expect(consumeOnboardingCallbackUrl()).toBeUndefined();
  });

  it('should not stash when callbackUrl is missing or unsafe', () => {
    stashOnboardingCallbackUrl('?step=2');
    expect(peekOnboardingCallbackUrl()).toBeUndefined();

    stashOnboardingCallbackUrl(`?callbackUrl=${encodeURIComponent('https://evil.com')}`);
    expect(peekOnboardingCallbackUrl()).toBeUndefined();
  });

  it('should not clobber an existing stash with internal navigations', () => {
    stashOnboardingCallbackUrl('?callbackUrl=%2Fdiscover');
    stashOnboardingCallbackUrl('?entry=skip');

    expect(peekOnboardingCallbackUrl()).toBe('/discover');
  });
});

describe('resolvePostOnboardingTargetUrl', () => {
  it('should preserve an explicit task-mode callback', () => {
    stashOnboardingCallbackUrl('?callbackUrl=%2F%3Fonboarding%3Dtask');

    expect(resolvePostOnboardingTargetUrl()).toBe('/?onboarding=task');
    expect(peekOnboardingCallbackUrl()).toBeUndefined();
  });

  it('should use the stashed callbackUrl when one exists', () => {
    stashOnboardingCallbackUrl('?callbackUrl=%2Fagent%2Fabc%3Fmessage%3Dhi');

    expect(resolvePostOnboardingTargetUrl()).toBe('/agent/abc?message=hi');
    expect(peekOnboardingCallbackUrl()).toBeUndefined();
  });

  it('should return the default home without opting into task mode when no callbackUrl exists', () => {
    expect(resolvePostOnboardingTargetUrl()).toBe('/');
  });
});

describe('clearStaleOnboardingCallbackUrl', () => {
  beforeEach(() => {
    stashOnboardingCallbackUrl('?callbackUrl=%2Fdiscover');
  });

  it('should clear a stale stash on a fresh top-level entry without callbackUrl', () => {
    clearStaleOnboardingCallbackUrl('/onboarding', '');

    expect(peekOnboardingCallbackUrl()).toBeUndefined();
  });

  it('should clear when the supplied callbackUrl is unsafe', () => {
    clearStaleOnboardingCallbackUrl(
      '/onboarding',
      `?callbackUrl=${encodeURIComponent('https://evil.com')}`,
    );

    expect(peekOnboardingCallbackUrl()).toBeUndefined();
  });

  it('should keep the stash when a valid callbackUrl is present', () => {
    clearStaleOnboardingCallbackUrl('/onboarding', '?callbackUrl=%2Fsettings');

    expect(peekOnboardingCallbackUrl()).toBe('/discover');
  });

  it('should keep the stash on shared-prefix re-entries carrying a step param', () => {
    clearStaleOnboardingCallbackUrl('/onboarding', '?step=1');

    expect(peekOnboardingCallbackUrl()).toBe('/discover');
  });

  it('should keep the stash on branch paths', () => {
    clearStaleOnboardingCallbackUrl('/onboarding/agent', '');
    clearStaleOnboardingCallbackUrl('/onboarding/classic', '?entry=skip');

    expect(peekOnboardingCallbackUrl()).toBe('/discover');
  });
});
