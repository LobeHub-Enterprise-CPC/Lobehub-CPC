import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAgentItemPath } from './itemPath';

// Tests read the distribution's flags; pin the stock (off) value per test.
let mockAgentProfileNavigation = false;
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get AGENT_PROFILE_NAVIGATION() {
    return mockAgentProfileNavigation;
  },
}));

afterEach(() => {
  mockAgentProfileNavigation = false;
});

describe('getAgentItemPath', () => {
  it('opens the conversation', () => {
    expect(getAgentItemPath({ id: 'agt_1', type: 'agent' })).toBe('/agent/agt_1');
    expect(getAgentItemPath({ id: 'cg_1', type: 'group' })).toBe('/group/cg_1');
  });

  it('opens the profile when the Home panel is the only everyday navigation', () => {
    mockAgentProfileNavigation = true;
    expect(getAgentItemPath({ id: 'agt_1', type: 'agent' })).toBe('/agent/agt_1/profile');
    expect(getAgentItemPath({ id: 'cg_1', type: 'group' })).toBe('/group/cg_1/profile');
  });
});
