/**
 * @vitest-environment happy-dom
 */
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AgentSelectorModule from '@/store/agent/selectors';

import AgentDock from '../AgentDock';

const resolved = vi.hoisted(() => {
  let agentId: string | undefined = 'agt_selected';
  const listeners = new Set<() => void>();

  return {
    get: () => agentId,
    set: (next: string | undefined) => {
      agentId = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
const home = vi.hoisted(() => ({ inputActiveMode: null as string | null }));
const agentFlags = vi.hoisted(() => ({ configLoading: false, heterogeneous: false }));
const modeFlags = vi.hoisted(() => ({ isAgentRuntimeMode: true, isPreferenceLoading: false }));
const accessFlags = vi.hoisted(() => ({ canConfigureResource: true, isAccessLoading: false }));

vi.mock('@/features/Home/AgentSelect', () => ({
  default: () => <div data-testid={'home-agent-select'} />,
}));

vi.mock('../ProjectSelect', () => ({
  default: () => <div data-testid={'home-project-select'} />,
}));

vi.mock('@/features/Home/AgentSelect/useResolvedHomeAgentId', async () => {
  const { useSyncExternalStore } = await import('react');

  return {
    useResolvedHomeAgentId: () => ({
      agentId: useSyncExternalStore(resolved.subscribe, resolved.get, resolved.get),
      isInbox: false,
    }),
  };
});

vi.mock('@/store/home', () => ({
  useHomeStore: (selector: (state: { inputActiveMode: string | null }) => unknown) =>
    selector({ inputActiveMode: home.inputActiveMode }),
}));

vi.mock('@/store/chat', () => {
  const state = { activeTopicId: 'stale-topic' };
  const useChatStore = (selector?: (value: typeof state) => unknown) =>
    typeof selector === 'function' ? selector(state) : state;
  useChatStore.getState = () => state;
  return { useChatStore };
});

vi.mock('@/store/agent', () => {
  const state = { activeAgentId: 'global-agent' };
  const useAgentStore = (selector?: (value: typeof state) => unknown) =>
    typeof selector === 'function' ? selector(state) : state;
  useAgentStore.getState = () => state;
  return { useAgentStore };
});

vi.mock('@/store/agent/selectors', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSelectorModule>();
  return {
    ...actual,
    agentByIdSelectors: {
      ...actual.agentByIdSelectors,
      isAgentConfigLoadingById: () => () => agentFlags.configLoading,
      isAgentHeterogeneousById: () => () => agentFlags.heterogeneous,
    },
  };
});

vi.mock('@/features/ChatInput/hooks/useEffectiveAgentMode', () => ({
  useEffectiveAgentMode: () => modeFlags,
}));

vi.mock('@/features/ChatInput/hooks/useChatInputResourceAccess', () => ({
  useChatInputResourceAccess: () => accessFlags,
}));

vi.mock('@/features/ChatInput/ControlBar/WorkspaceControls', async () => {
  const { createElement } = await import('react');
  const { useAgentId } = await import('@/features/ChatInput/hooks/useAgentId');
  const { useTopicId } = await import('@/features/ChatInput/hooks/useTopicId');

  return {
    default: function WorkspaceControlsProbe({
      agentId: propAgentId,
      alwaysShowWorkspace,
      placePicker,
      placePickerPlacement,
    }: {
      agentId: string;
      alwaysShowWorkspace?: boolean;
      placePicker?: boolean;
      placePickerPlacement?: string;
    }) {
      const topicId = useTopicId();
      const agentId = useAgentId();

      return createElement('div', {
        'data-agent-id': agentId,
        'data-always-show': String(Boolean(alwaysShowWorkspace)),
        'data-place-picker': String(Boolean(placePicker)),
        'data-placement': String(placePickerPlacement),
        'data-prop-agent-id': propAgentId,
        'data-testid': 'workspace-controls',
        'data-topic-id': topicId === null ? 'null' : String(topicId),
      });
    },
  };
});

vi.mock('@/features/ChatInput/ControlBar/executionPlace/ExecutionPlacePicker', async () => {
  const { createElement } = await import('react');
  const { useAgentId } = await import('@/features/ChatInput/hooks/useAgentId');
  const { useTopicId } = await import('@/features/ChatInput/hooks/useTopicId');

  return {
    ExecutionPlacePicker: function ExecutionPlacePickerProbe({
      agentId: propAgentId,
      allowDirectory,
      placement,
    }: {
      agentId: string;
      allowDirectory?: boolean;
      placement?: string;
    }) {
      const topicId = useTopicId();
      const agentId = useAgentId();

      return createElement('div', {
        'data-agent-id': agentId,
        'data-allow-directory': String(allowDirectory !== false),
        'data-placement': String(placement),
        'data-prop-agent-id': propAgentId,
        'data-testid': 'execution-place-picker',
        'data-topic-id': topicId === null ? 'null' : String(topicId),
      });
    },
  };
});

vi.mock('@/features/ChatInput/ControlBar/DeviceSwitcher', async () => {
  const { createElement } = await import('react');
  const { useAgentId } = await import('@/features/ChatInput/hooks/useAgentId');
  const { useTopicId } = await import('@/features/ChatInput/hooks/useTopicId');

  return {
    default: function DeviceSwitcherProbe({ agentId: propAgentId }: { agentId: string }) {
      const topicId = useTopicId();
      const agentId = useAgentId();

      return createElement('div', {
        'data-agent-id': agentId,
        'data-prop-agent-id': propAgentId,
        'data-testid': 'device-switcher',
        'data-topic-id': topicId === null ? 'null' : String(topicId),
      });
    },
  };
});

const renderDock = (mode: 'chat' | 'task' = 'chat') => render(<AgentDock mode={mode} />);

describe('AgentDock workspace cluster', () => {
  beforeEach(() => {
    resolved.set('agt_selected');
    home.inputActiveMode = null;
    agentFlags.configLoading = false;
    agentFlags.heterogeneous = false;
    modeFlags.isAgentRuntimeMode = true;
    modeFlags.isPreferenceLoading = false;
    accessFlags.canConfigureResource = true;
    accessFlags.isAccessLoading = false;
  });

  it('hides the cluster for a normal agent that is not in agent runtime mode', async () => {
    modeFlags.isAgentRuntimeMode = false;
    renderDock();

    await waitFor(() => expect(screen.queryByTestId('home-dock-workspace')).toBeNull());
    expect(screen.getByTestId('home-agent-select')).toBeTruthy();
    expect(screen.queryByTestId('workspace-controls')).toBeNull();
  });

  it('renders workspace controls for an agent-runtime agent, bound to that agent and no topic', async () => {
    renderDock();

    const controls = await screen.findByTestId('workspace-controls');
    expect(controls.dataset.topicId).toBe('null');
    expect(controls.dataset.agentId).toBe('agt_selected');
    expect(controls.dataset.propAgentId).toBe('agt_selected');
    expect(controls.dataset.alwaysShow).toBe('false');
    expect(controls.dataset.placePicker).toBe('true');
    expect(screen.queryByTestId('device-switcher')).toBeNull();
  });

  it('keeps topicId null after the selected agent changes', async () => {
    renderDock();
    await screen.findByTestId('workspace-controls');

    act(() => resolved.set('agt_next'));

    const controls = screen.getByTestId('workspace-controls');
    expect(controls.dataset.propAgentId).toBe('agt_next');
    expect(controls.dataset.agentId).toBe('agt_next');
    expect(controls.dataset.topicId).toBe('null');
  });

  it('renders the workspace for a heterogeneous agent and forces it on', async () => {
    agentFlags.heterogeneous = true;
    modeFlags.isAgentRuntimeMode = false;
    renderDock();

    const controls = await screen.findByTestId('workspace-controls');
    expect(controls.dataset.alwaysShow).toBe('true');
    // The dock sits at the composer's right edge, so the cascade opens leftwards.
    expect(controls.dataset.placement).toBe('left');
    expect(controls.dataset.topicId).toBe('null');
    expect(controls.dataset.agentId).toBe('agt_selected');
  });

  it('shows only the device switcher when a heterogeneous member cannot configure the agent', async () => {
    agentFlags.heterogeneous = true;
    accessFlags.canConfigureResource = false;
    renderDock();

    const device = await screen.findByTestId('execution-place-picker');
    expect(device.dataset.topicId).toBe('null');
    expect(device.dataset.agentId).toBe('agt_selected');
    expect(device.dataset.allowDirectory).toBe('false');
    expect(device.dataset.placement).toBe('left');
    expect(screen.queryByTestId('workspace-controls')).toBeNull();
    expect(screen.queryByTestId('device-switcher')).toBeNull();
  });

  it('still mounts workspace controls for a normal agent the member cannot configure', async () => {
    accessFlags.canConfigureResource = false;
    renderDock();

    expect(await screen.findByTestId('workspace-controls')).toBeTruthy();
    expect(screen.queryByTestId('device-switcher')).toBeNull();
  });

  it('hides the cluster in task mode and while another home input mode is active', () => {
    renderDock('task');
    expect(screen.queryByTestId('home-dock-workspace')).toBeNull();

    home.inputActiveMode = 'agent';
    renderDock('chat');
    expect(screen.queryByTestId('workspace-controls')).toBeNull();

    home.inputActiveMode = 'research';
    renderDock('chat');
    expect(screen.queryByTestId('home-dock-workspace')).toBeNull();
  });

  it('shows a skeleton instead of controls while the agent is unresolved or its config is loading', async () => {
    resolved.set(undefined);
    const { unmount } = renderDock();
    expect(screen.getByTestId('home-dock-workspace')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByTestId('workspace-controls')).toBeNull();
    unmount();

    resolved.set('agt_selected');
    agentFlags.configLoading = true;
    renderDock();
    await waitFor(() =>
      expect(screen.getByTestId('home-dock-workspace')).toHaveAttribute('data-pending', 'config'),
    );
    expect(screen.queryByTestId('workspace-controls')).toBeNull();
  });
});
