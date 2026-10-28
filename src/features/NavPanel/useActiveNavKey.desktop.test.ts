import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDisplayedTabStore } from '@/features/Electron/TabHost/displayedTab';
import { useElectronStore } from '@/store/electron';
import { useGlobalStore } from '@/store/global';

import { useActiveNavKey, useExitNavAdvancedMode } from './useActiveNavKey.desktop';

let workspaceSlug: string | null = null;
let agentProfileNavigation = false;

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get AGENT_PROFILE_NAVIGATION() {
    return agentProfileNavigation;
  },
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  useActiveWorkspaceSlug: () => workspaceSlug,
}));

const tab = (id: string, url: string) => ({ id, lastVisited: 0, url });

afterEach(() => {
  useElectronStore.setState({ activeTabId: null, tabs: [] });
  useDisplayedTabStore.setState({ tabId: null });
  useGlobalStore.setState({ navAdvancedTargetId: undefined });
  workspaceSlug = null;
  agentProfileNavigation = false;
});

describe('useActiveNavKey (desktop)', () => {
  it('keeps the panel of the tab on screen until the clicked tab is revealed', () => {
    useElectronStore.setState({
      activeTabId: 'topic',
      tabs: [tab('home', '/'), tab('topic', '/agent/agt_a/tpc_a')],
    });
    useDisplayedTabStore.setState({ tabId: 'home' });

    const { result } = renderHook(() => useActiveNavKey());
    expect(result.current).toBe('home');

    act(() => useDisplayedTabStore.setState({ tabId: 'topic' }));
    expect(result.current).toBe('agent');
  });

  it('follows in-tab navigation of the displayed tab', () => {
    useElectronStore.setState({ activeTabId: 'only', tabs: [tab('only', '/')] });
    useDisplayedTabStore.setState({ tabId: 'only' });

    const { result } = renderHook(() => useActiveNavKey());
    act(() => useElectronStore.getState().reportTabLocation('only', '/agent/agt_a?thread=x'));

    expect(result.current).toBe('agent');
  });

  it('falls back to the active tab before any tab is displayed', () => {
    useElectronStore.setState({ activeTabId: 'only', tabs: [tab('only', '/community')] });

    const { result } = renderHook(() => useActiveNavKey());

    expect(result.current).toBe('discover');
  });

  it('shows the advanced owner panel instead of Home when profile navigation is enabled', () => {
    agentProfileNavigation = true;
    useGlobalStore.setState({ navAdvancedTargetId: 'agt_a' });
    useElectronStore.setState({
      activeTabId: 'only',
      tabs: [tab('only', '/agent/agt_a/docs?x=1#last')],
    });
    useDisplayedTabStore.setState({ tabId: 'only' });

    const { result } = renderHook(() => useActiveNavKey());
    expect(result.current).toBe('agent-docs');
  });
});

describe('useExitNavAdvancedMode (desktop)', () => {
  it.each([
    ['/agent/agt_a/profile?x=1#last', null, 'agt_a'],
    ['/team/agent/agt_a/docs?x=1#last', 'team', 'agt_a'],
    ['/team/group/grp_a/topic?x=1#last', 'team', 'grp_a'],
  ])('keeps advanced mode within the displayed owner at %s', (url, slug, owner) => {
    workspaceSlug = slug;
    useGlobalStore.setState({ navAdvancedTargetId: owner });
    useElectronStore.setState({ activeTabId: 'only', tabs: [tab('only', url)] });
    useDisplayedTabStore.setState({ tabId: 'only' });

    renderHook(() => useExitNavAdvancedMode());
    expect(useGlobalStore.getState().navAdvancedTargetId).toBe(owner);
  });

  it('waits for the clicked tab to be displayed before clearing the previous owner', () => {
    agentProfileNavigation = true;
    useGlobalStore.setState({ navAdvancedTargetId: 'agt_a' });
    useElectronStore.setState({
      activeTabId: 'other',
      tabs: [tab('owner', '/agent/agt_a'), tab('other', '/agent/agt_b')],
    });
    useDisplayedTabStore.setState({ tabId: 'owner' });
    const { result } = renderHook(() => {
      useExitNavAdvancedMode();
      return useActiveNavKey();
    });
    expect(result.current).toBe('agent');
    expect(useGlobalStore.getState().navAdvancedTargetId).toBe('agt_a');

    act(() => useDisplayedTabStore.setState({ tabId: 'other' }));
    expect(useGlobalStore.getState().navAdvancedTargetId).toBeUndefined();
    expect(result.current).toBe('home');
  });

  it.each(['/resource', '/team/group/grp_b?x=1#last', undefined])(
    'clears advanced mode after the displayed route leaves its owner: %s',
    (url) => {
      workspaceSlug = 'team';
      useGlobalStore.setState({ navAdvancedTargetId: 'agt_a' });
      useElectronStore.setState({
        activeTabId: url ? 'only' : null,
        tabs: url ? [tab('only', url)] : [],
      });
      useDisplayedTabStore.setState({ tabId: url ? 'only' : null });

      renderHook(() => useExitNavAdvancedMode());
      expect(useGlobalStore.getState().navAdvancedTargetId).toBeUndefined();
    },
  );
});
