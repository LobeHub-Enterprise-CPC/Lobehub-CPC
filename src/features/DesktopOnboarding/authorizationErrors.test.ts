import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import desktopOnboarding from '../../../packages/locales/src/default/desktop-onboarding';
import {
  authorizationErrorI18nKeyMap,
  canFindByOrganizationEmail,
  getAuthorizationErrorI18nKey,
  isSupersededAuthorization,
  requiresExplicitSwitch,
} from './authorizationErrors';

const localeJson = (locale: string) =>
  JSON.parse(
    readFileSync(
      path.resolve(__dirname, `../../../locales/${locale}/desktop-onboarding.json`),
      'utf8',
    ),
  ) as Record<string, string>;

describe('authorization error copy', () => {
  const keys = Object.values(authorizationErrorI18nKeyMap).filter((key): key is string => !!key);

  it('has copy in the default namespace and both hand-maintained locales for every mapped code', () => {
    for (const key of keys) {
      expect(desktopOnboarding, key).toHaveProperty([key]);
      expect(localeJson('en-US'), key).toHaveProperty([key]);
      expect(localeJson('zh-CN'), key).toHaveProperty([key]);
    }
  });

  it('maps a platform configuration error to its own copy with no extra recovery action', () => {
    expect(getAuthorizationErrorI18nKey('PLATFORM_MISCONFIGURED')).toBe(
      'screen5.errors.platformMisconfigured',
    );
    expect(canFindByOrganizationEmail('PLATFORM_MISCONFIGURED')).toBe(false);
    expect(requiresExplicitSwitch('PLATFORM_MISCONFIGURED')).toBe(false);
  });

  it('only hides the superseded code, which is bookkeeping rather than a failure', () => {
    const hidden = Object.entries(authorizationErrorI18nKeyMap)
      .filter(([, key]) => key === null)
      .map(([code]) => code);

    expect(hidden).toEqual(['FLOW_SUPERSEDED']);
    expect(getAuthorizationErrorI18nKey('FLOW_SUPERSEDED')).toBeUndefined();
    expect(isSupersededAuthorization('FLOW_SUPERSEDED')).toBe(true);
  });

  it('falls back for a code this build does not know and for no code', () => {
    expect(getAuthorizationErrorI18nKey(undefined)).toBeUndefined();
    expect(getAuthorizationErrorI18nKey('SOMETHING_NEW' as never)).toBeUndefined();
  });

  it('routes only the invalid organization address to the email lookup', () => {
    expect(canFindByOrganizationEmail('INVALID_ORGANIZATION_ADDRESS')).toBe(true);
    expect(canFindByOrganizationEmail('INVALID_SERVER_ADDRESS')).toBe(false);
    expect(requiresExplicitSwitch('ORGANIZATION_CHANGED_SWITCH_REQUIRED')).toBe(true);
  });
});
