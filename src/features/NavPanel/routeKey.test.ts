import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveNavPanelKey, resolveRouteOwnerId } from './routeKey';

// Tests read the distribution's flags; pin the stock (off) value per test.
let mockProjectFirst = false;
let mockAgentProfileNavigation = false;
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get AGENT_PROFILE_NAVIGATION() {
    return mockAgentProfileNavigation;
  },
  get PROJECT_FIRST_NAVIGATION() {
    return mockProjectFirst;
  },
}));

afterEach(() => {
  mockProjectFirst = false;
  mockAgentProfileNavigation = false;
});

describe('resolveNavPanelKey', () => {
  it.each([
    ['/', null, 'home'],
    ['/lobe-team', 'lobe-team', 'home'],
    ['/tasks', null, 'home'],
    ['/lobe-team/task/task-1', 'lobe-team', 'home'],
    ['/agent/agent-1', null, 'agent'],
    ['/lobe-team/agent/agent-1', 'lobe-team', 'agent'],
    ['/agent/agent-1/docs', null, 'agent-docs'],
    ['/agent/agent-1/docs/docs-1', null, 'agent-docs'],
    ['/lobe-team/agent/agent-1/docs/docs-1', 'lobe-team', 'agent-docs'],
    ['/group/group-1', null, 'group'],
    ['/channels', null, 'home'],
    ['/channels/channel-1', null, 'home'],
    ['/settings/profile', null, 'settings'],
    ['/lobe-team/settings/general', 'lobe-team', 'workspace-settings'],
    ['/lobe-team/community', 'lobe-team', 'discover'],
    ['/lobe-team/resource', 'lobe-team', 'resource'],
    ['/lobe-team/resource/library', 'lobe-team', 'resourceLibrary'],
    ['/lobe-team/memory', 'lobe-team', 'memory'],
    ['/lobe-team/eval', 'lobe-team', 'eval'],
    ['/lobe-team/eval/bench/benchmark-1', 'lobe-team', 'evalBench'],
    ['/lobe-team/page/page-1', 'lobe-team', 'page'],
    ['/project/project-1', null, 'project'],
    ['/project/project-1/conversation/tpc-1', null, 'project'],
    ['/lobe-team/project/project-1/library/kb-1', 'lobe-team', 'project'],
    ['/lobe-team/image', 'lobe-team', 'image'],
    ['/lobe-team/video', 'lobe-team', 'video'],
  ])('maps %s to %s', (pathname, activeWorkspaceSlug, expected) => {
    expect(resolveNavPanelKey(pathname, activeWorkspaceSlug)).toBe(expected);
  });

  describe('when projects lead navigation', () => {
    it.each([
      ['/project/project-1/conversation/tpc-1', null, 'home'],
      ['/lobe-team/project/project-1/conversation/tpc-1', 'lobe-team', 'home'],
      // The project page itself keeps its own sidebar.
      ['/project/project-1', null, 'project'],
      ['/project/project-1/conversation', null, 'project'],
      ['/project/project-1/settings', null, 'project'],
    ])('maps %s to %s', (pathname, activeWorkspaceSlug, expected) => {
      mockProjectFirst = true;

      expect(resolveNavPanelKey(pathname, activeWorkspaceSlug)).toBe(expected);
    });
  });

  describe('when the Home panel is the only everyday navigation', () => {
    it.each([
      ['/agent/agt-1', null, undefined, 'home'],
      ['/agent/agt-1/profile', null, undefined, 'home'],
      ['/lobe-team/agent/agt-1/tpc-1', 'lobe-team', undefined, 'home'],
      ['/agent/agt-1/docs/docs-1', null, undefined, 'home'],
      ['/group/grp-1', null, undefined, 'home'],
      ['/group/grp-1/profile', null, undefined, 'home'],
      // Advanced mode opens that agent's or group's own sidebar, and only theirs.
      ['/agent/agt-1', null, 'agt-1', 'agent'],
      ['/agent/agt-1/docs/docs-1', null, 'agt-1', 'agent-docs'],
      ['/lobe-team/agent/agt-1/profile', 'lobe-team', 'agt-1', 'agent'],
      ['/agent/agt-2', null, 'agt-1', 'home'],
      ['/group/grp-1/tpc-1', null, 'grp-1', 'group'],
      // Other sections keep their panels.
      ['/project/project-1', null, undefined, 'project'],
      ['/settings/profile', null, undefined, 'settings'],
    ])('maps %s (advanced: %s) to %s', (pathname, activeWorkspaceSlug, advanced, expected) => {
      mockAgentProfileNavigation = true;
      expect(resolveNavPanelKey(pathname, activeWorkspaceSlug, advanced)).toBe(expected);
    });

    it('keeps the agent sidebar when the flag is off', () => {
      expect(resolveNavPanelKey('/agent/agt-1', null)).toBe('agent');
    });
  });
});

describe('resolveRouteOwnerId', () => {
  it.each([
    ['/agent/agt-1/tpc-1', null, 'agt-1'],
    ['/lobe-team/group/grp-1/profile', 'lobe-team', 'grp-1'],
    ['/project/project-1', null, undefined],
    ['/', null, undefined],
  ])('reads the owner of %s', (pathname, activeWorkspaceSlug, expected) => {
    expect(resolveRouteOwnerId(pathname, activeWorkspaceSlug)).toBe(expected);
  });
});
