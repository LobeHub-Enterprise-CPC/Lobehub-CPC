import { afterEach, describe, expect, it, vi } from 'vitest';

import { AGENT_PROFILE_TABS_CENTER_STYLE, getAgentProfileTabsCenterStyle } from './centerStyle';

describe('getAgentProfileTabsCenterStyle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('centers the switcher on the header midpoint on desktop', () => {
    vi.stubGlobal('__MOBILE__', false);

    expect(getAgentProfileTabsCenterStyle()).toBe(AGENT_PROFILE_TABS_CENTER_STYLE);
  });

  it('keeps the switcher in the flow on mobile so it cannot cover the back button', () => {
    vi.stubGlobal('__MOBILE__', true);

    const style = getAgentProfileTabsCenterStyle();

    expect(style.position).toBeUndefined();
    expect(style.minWidth).toBe(0);
    expect(style.overflowX).toBe('auto');
  });
});
