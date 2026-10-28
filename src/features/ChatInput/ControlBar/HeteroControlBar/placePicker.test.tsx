/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import HeteroControlBar from '.';

const flags = vi.hoisted(() => ({
  canConfigureResource: false,
  isAccessLoading: false,
  layout: false,
  projectTopicId: undefined as string | undefined,
}));

vi.mock('@lobechat/const', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isDesktop: true,
}));

vi.mock('@lobechat/electron-client-ipc', () => ({
  useWatchBroadcast: vi.fn(),
}));

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get COMPOSER_AGENT_ONLY_LAYOUT() {
    return flags.layout;
  },
}));

vi.mock('@/business/client/features/ChatInputCredits', () => ({
  default: () => <div data-testid={'api-credits'} />,
}));

vi.mock('@/features/ChatInput/ControlBar/WorkspaceControls', () => ({
  default: () => <div data-testid={'workspace-controls'} />,
}));

vi.mock('@/features/ChatInput/ControlBar/DeviceSwitcher', () => ({
  default: () => <div data-testid={'device-switcher'} />,
}));

vi.mock('@/features/ChatInput/ControlBar/executionPlace/ExecutionPlacePicker', () => ({
  ExecutionPlacePicker: ({ allowDirectory }: { allowDirectory?: boolean }) => (
    <div
      data-allow-directory={String(Boolean(allowDirectory))}
      data-testid={'execution-place-picker'}
    />
  ),
}));

vi.mock('@/features/ChatInput/ControlBar/useProjectTopicDirectory', () => ({
  useActiveProjectDirectoryTopicId: () => flags.projectTopicId,
  useStagedProjectDirectoryId: () => undefined,
}));

vi.mock('@/features/ChatInput/hooks/useAgentId', () => ({ useAgentId: () => 'agent-1' }));
vi.mock('@/features/ChatInput/hooks/useTopicId', () => ({ useTopicId: () => 'topic-1' }));

vi.mock('@/features/ChatInput/hooks/useChatInputResourceAccess', () => ({
  useChatInputResourceAccess: () => ({
    canConfigureResource: flags.canConfigureResource,
    canSendMessage: true,
    canUseResource: true,
    isAccessLoading: flags.isAccessLoading,
  }),
}));

vi.mock('@/hooks/useEffectiveAgencyConfig', () => ({
  useEffectiveAgencyConfig: () => ({
    agencyConfig: {
      boundDeviceId: 'personal-device',
      executionTarget: 'local',
      heterogeneousProvider: { command: 'codex', type: 'codex' },
    },
    workspaceScoped: false,
  }),
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: Record<string, unknown>) => unknown) => selector({}),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    isAgentConfigLoadingById: () => () => false,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return {
    ...actual,
    Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Icon: () => <svg />,
    Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  };
});

describe('HeteroControlBar use-only place picker', () => {
  beforeEach(() => {
    flags.canConfigureResource = false;
    flags.isAccessLoading = false;
    flags.layout = false;
    flags.projectTopicId = undefined;
  });

  it('keeps the device chip when the enterprise layout is off', () => {
    render(<HeteroControlBar />);

    expect(screen.getByTestId('device-switcher')).toBeTruthy();
    expect(screen.queryByTestId('execution-place-picker')).toBeNull();
  });

  it('replaces the device chip when the enterprise layout is on', () => {
    flags.layout = true;

    render(<HeteroControlBar />);

    const picker = screen.getByTestId('execution-place-picker');
    expect(picker.dataset.allowDirectory).toBe('false');
    expect(screen.queryByTestId('device-switcher')).toBeNull();
  });

  it('keeps the device chip for a project-directory topic', () => {
    flags.layout = true;
    flags.projectTopicId = 'topic-project';

    render(<HeteroControlBar />);

    expect(screen.getByTestId('device-switcher')).toBeTruthy();
    expect(screen.queryByTestId('execution-place-picker')).toBeNull();
  });
});
