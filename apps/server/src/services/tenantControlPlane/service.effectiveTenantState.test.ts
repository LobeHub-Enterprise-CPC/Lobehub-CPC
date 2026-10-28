import { beforeEach, describe, expect, it } from 'vitest';

import { NOW, resetService } from './__tests__/service.testUtils';
import { effectiveTenantState } from './service';

beforeEach(() => {
  resetService();
});

describe('effectiveTenantState', () => {
  it.each([null, '2030-01-01T00:00:00.000Z'])(
    'derives expired from expiresAt after renewal (%s)',
    (expiresAt) => {
      expect(
        effectiveTenantState(
          { desiredState: 'active', expiresAt, freezeReasons: ['expired'] },
          NOW,
        ),
      ).toEqual({ state: 'active', reasons: [] });
      expect(
        effectiveTenantState(
          { desiredState: 'active', expiresAt, freezeReasons: ['expired', 'manual'] },
          NOW,
        ),
      ).toEqual({ state: 'frozen', reasons: ['manual'] });
    },
  );
  const base = { desiredState: 'active' as const, expiresAt: null, freezeReasons: [] };

  it('is active with no reasons and no expiry', () => {
    expect(effectiveTenantState(base, NOW)).toEqual({ reasons: [], state: 'active' });
  });

  it('freezes at expiry without waiting for an expired event', () => {
    expect(effectiveTenantState({ ...base, expiresAt: NOW.toISOString() }, NOW)).toEqual({
      reasons: ['expired'],
      state: 'frozen',
    });
  });

  it('puts offline above frozen', () => {
    expect(
      effectiveTenantState({ ...base, desiredState: 'offline', freezeReasons: ['manual'] }, NOW)
        .state,
    ).toBe('offline');
  });
});
