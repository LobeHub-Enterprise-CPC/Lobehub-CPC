import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveNavPanelKey } from './routeKey';

// Tests read the distribution's flags; pin the stock (off) value per test.
let mockProjectFirst = false;
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get PROJECT_FIRST_NAVIGATION() {
    return mockProjectFirst;
  },
}));

afterEach(() => {
  mockProjectFirst = false;
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
});
