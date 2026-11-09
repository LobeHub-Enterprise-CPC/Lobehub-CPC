import { afterEach, describe, expect, it, vi } from 'vitest';

import { SkillNavKey } from './types';

const layout = vi.hoisted(() => ({ showcase: false }));

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get COMMUNITY_SHOWCASE_LAYOUT() {
    return layout.showcase;
  },
}));

// The tab list is read from the layout slot when the module loads.
const loadConst = async () => {
  vi.resetModules();
  return import('./const');
};

afterEach(() => {
  layout.showcase = false;
});

describe('skill detail tabs', () => {
  it('keeps the install guide in the upstream layout', async () => {
    const { resolveSkillNavKey, SKILL_NAV_KEYS } = await loadConst();

    expect(SKILL_NAV_KEYS).toContain(SkillNavKey.Install);
    expect(resolveSkillNavKey(SkillNavKey.Install)).toBe(SkillNavKey.Install);
  });

  it('drops the install guide in the showcase layout and opens old links on the overview', async () => {
    layout.showcase = true;
    const { resolveSkillNavKey, SKILL_NAV_KEYS } = await loadConst();

    expect(SKILL_NAV_KEYS).toEqual([SkillNavKey.Overview, SkillNavKey.Reviews, SkillNavKey.Info]);
    expect(resolveSkillNavKey(SkillNavKey.Install)).toBe(SkillNavKey.Overview);
    expect(resolveSkillNavKey(SkillNavKey.Reviews)).toBe(SkillNavKey.Reviews);
    expect(resolveSkillNavKey(undefined)).toBe(SkillNavKey.Overview);
  });
});
