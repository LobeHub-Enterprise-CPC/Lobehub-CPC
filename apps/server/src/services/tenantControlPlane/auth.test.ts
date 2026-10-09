import { describe, expect, it } from 'vitest';

import { isAuthorized, parseControlPlaneGrants } from './auth';

const FULL = 'f'.repeat(32);
const READER = 'r'.repeat(40);

describe('parseControlPlaneGrants', () => {
  it('returns null when nothing is configured', () => {
    expect(parseControlPlaneGrants({})).toBeNull();
  });

  it('rejects a token shorter than 32 characters', () => {
    expect(() => parseControlPlaneGrants({ LOBEHUB_CONTROL_PLANE_TOKEN: 'short' })).toThrow();
  });

  it('rejects an unknown action rather than ignoring it', () => {
    expect(() =>
      parseControlPlaneGrants({
        LOBEHUB_CONTROL_PLANE_TOKENS_JSON: JSON.stringify([
          { actions: ['tenant.everything'], token: READER },
        ]),
      }),
    ).toThrow();
  });
});

describe('isAuthorized', () => {
  const grants = parseControlPlaneGrants({
    LOBEHUB_CONTROL_PLANE_TOKEN: FULL,
    LOBEHUB_CONTROL_PLANE_TOKENS_JSON: JSON.stringify([
      { actions: ['tenant.overview.read'], token: READER },
    ]),
  })!;

  it('grants the single token every action', () => {
    expect(isAuthorized(grants, `Bearer ${FULL}`, 'tenant.provision')).toBe(true);
    expect(isAuthorized(grants, `Bearer ${FULL}`, 'tenant.datasource.apply')).toBe(true);
  });

  it('limits a split token to its listed actions', () => {
    expect(isAuthorized(grants, `Bearer ${READER}`, 'tenant.overview.read')).toBe(true);
    expect(isAuthorized(grants, `Bearer ${READER}`, 'tenant.datasource.apply')).toBe(false);
  });

  it('refuses a missing, malformed or wrong token', () => {
    expect(isAuthorized(grants, undefined, 'tenant.provision')).toBe(false);
    expect(isAuthorized(grants, FULL, 'tenant.provision')).toBe(false);
    expect(isAuthorized(grants, `Bearer ${FULL}x`, 'tenant.provision')).toBe(false);
  });
});
