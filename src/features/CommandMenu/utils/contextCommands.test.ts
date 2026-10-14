import type * as BusinessConst from '@lobechat/business-const';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `SETTINGS_HIDDEN_TABS` is read once at module scope, so each case has to
 * re-import the module from cold — a statically imported `hiddenTabs` would pin
 * the value from the first mock and every later case would assert against it.
 */
const loadBuildContextCommands = async (hidden: readonly string[]) => {
  vi.resetModules();
  vi.doMock('@lobechat/business-const', async (importOriginal) => ({
    ...(await importOriginal<typeof BusinessConst>()),
    SETTINGS_HIDDEN_TABS: hidden,
  }));

  const { buildContextCommands } = await import('./contextCommands');

  return buildContextCommands;
};

/** The settings `subPath`s the command palette can surface. */
const settingsSubPaths = async (hidden: readonly string[], enableBusinessFeatures = true) => {
  const buildContextCommands = await loadBuildContextCommands(hidden);

  return buildContextCommands({ enableBusinessFeatures }).settings.map((cmd) => cmd.subPath);
};

afterEach(() => {
  vi.doUnmock('@lobechat/business-const');
  vi.resetModules();
});

describe('settings commands vs SETTINGS_HIDDEN_TABS', () => {
  it('lists every settings entry when nothing is hidden', async () => {
    const subPaths = await settingsSubPaths([]);

    expect(subPaths).toEqual(
      expect.arrayContaining([
        'about',
        'common',
        'hotkey',
        'image',
        'profile',
        'provider',
        'stats',
        // Business entries, appended only under business features.
        'billing',
        'credits',
        'plans',
        'referral',
        'usage',
      ]),
    );
  });

  // The deployment hides plans / usage / credits / billing / referral, all of
  // which the palette listed unconditionally.
  it('drops exactly the hidden entries, and nothing else', async () => {
    const hidden = ['plans', 'usage', 'credits', 'billing', 'referral'];
    const before = await settingsSubPaths([]);
    const after = await settingsSubPaths(hidden);

    expect(after).toEqual(before.filter((subPath) => !hidden.includes(subPath)));
    for (const subPath of hidden) expect(after).not.toContain(subPath);
  });

  // A hidden tab whose page renders `null` is what makes the palette entry a
  // dead end: it stays searchable, and selecting it lands on a blank screen.
  it('removes the entries whose target page renders nothing', async () => {
    const subPaths = await settingsSubPaths(['plans', 'credits', 'usage', 'billing', 'referral']);

    expect(subPaths).not.toContain('plans');
    expect(subPaths).not.toContain('referral');
    // Entries this deployment keeps must survive the filter untouched.
    expect(subPaths).toEqual(expect.arrayContaining(['profile', 'provider', 'about']));
  });

  // The deny-list is shared with the sidebar, which lists tabs the palette never
  // had (credential / devices / notification / messenger). Hiding those must not
  // throw, and must not remove anything unrelated.
  it('is a no-op for hidden tabs the palette never listed', async () => {
    const hidden = ['credential', 'devices', 'messenger', 'notification'];

    expect(await settingsSubPaths(hidden)).toEqual(await settingsSubPaths([]));
  });

  it('leaves the business gate in charge of its own entries', async () => {
    const subPaths = await settingsSubPaths([], false);

    expect(subPaths).not.toContain('plans');
    expect(subPaths).toContain('profile');
  });
});
