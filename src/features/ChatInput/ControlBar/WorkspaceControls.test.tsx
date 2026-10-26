/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import WorkspaceControls from './WorkspaceControls';

const flags = vi.hoisted(() => ({
  canConfigureResource: true,
  canUseResource: true,
  layout: false,
  projectTopicId: undefined as string | undefined,
  stagedDirectoryId: undefined as string | undefined,
}));

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get COMPOSER_AGENT_ONLY_LAYOUT() {
    return flags.layout;
  },
}));

vi.mock('./useProjectTopicDirectory', () => ({
  useActiveProjectDirectoryTopicId: () => flags.projectTopicId,
  useStagedProjectDirectoryId: () => flags.stagedDirectoryId,
}));

vi.mock('./useWorkspaceSurface', () => ({
  useWorkspaceSurface: () => ['workingDirectory', 'cloudRepo'] as const,
}));

vi.mock('@/features/ChatInput/hooks/useChatInputResourceAccess', () => ({
  useChatInputResourceAccess: () => ({
    canConfigureResource: flags.canConfigureResource,
    canUseResource: flags.canUseResource,
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('./DeviceSwitcher', () => ({
  default: () => <div data-testid={'device-switcher'} />,
}));

vi.mock('./executionPlace/ExecutionPlacePicker', () => ({
  ExecutionPlacePicker: ({ allowDirectory }: { allowDirectory?: boolean }) => (
    <div
      data-allow-directory={String(Boolean(allowDirectory))}
      data-testid={'execution-place-picker'}
    />
  ),
}));

vi.mock('./WorkingDirectorySection', () => ({
  default: ({ hidePicker }: { hidePicker?: boolean }) => (
    <div data-hide-picker={String(Boolean(hidePicker))} data-testid={'working-directory-section'} />
  ),
}));

vi.mock('./CloudRepoSwitcher', () => ({
  default: () => <div data-testid={'cloud-repo'} />,
}));

vi.mock('./SandboxStorageSection', () => ({
  default: () => <div data-testid={'sandbox-storage'} />,
}));

describe('WorkspaceControls place picker flag', () => {
  beforeEach(() => {
    flags.canConfigureResource = true;
    flags.canUseResource = true;
    flags.layout = false;
    flags.projectTopicId = undefined;
    flags.stagedDirectoryId = undefined;
  });

  it('keeps the device chip and directory picker when the enterprise layout is off', () => {
    render(<WorkspaceControls agentId={'agent-1'} />);

    expect(screen.getByTestId('device-switcher')).toBeTruthy();
    expect(screen.queryByTestId('execution-place-picker')).toBeNull();
    expect(screen.getByTestId('working-directory-section').dataset.hidePicker).toBe('false');
    expect(screen.getByTestId('cloud-repo')).toBeTruthy();
  });

  it('replaces the device and directory chips when the enterprise layout is on', () => {
    flags.layout = true;

    render(<WorkspaceControls agentId={'agent-1'} />);

    const picker = screen.getByTestId('execution-place-picker');
    expect(picker.dataset.allowDirectory).toBe('true');
    expect(screen.queryByTestId('device-switcher')).toBeNull();
    expect(screen.getByTestId('working-directory-section').dataset.hidePicker).toBe('true');
    expect(screen.getByTestId('cloud-repo')).toBeTruthy();
  });

  it('forces the picker on the home dock even while the topic flag is off', () => {
    render(<WorkspaceControls placePicker agentId={'agent-1'} />);

    expect(screen.getByTestId('execution-place-picker')).toBeTruthy();
    expect(screen.queryByTestId('device-switcher')).toBeNull();
  });

  it('keeps DeviceSwitcher for a project-directory topic', () => {
    flags.layout = true;
    flags.projectTopicId = 'topic-project';

    render(<WorkspaceControls placePicker agentId={'agent-1'} />);

    expect(screen.getByTestId('device-switcher')).toBeTruthy();
    expect(screen.queryByTestId('execution-place-picker')).toBeNull();
    expect(screen.getByTestId('working-directory-section').dataset.hidePicker).toBe('false');
  });

  it('lets a use-only member switch place but not edit the directory', () => {
    flags.layout = true;
    flags.canConfigureResource = false;

    render(<WorkspaceControls agentId={'agent-1'} />);

    expect(screen.getByTestId('execution-place-picker').dataset.allowDirectory).toBe('false');
    expect(screen.getByTestId('working-directory-section').dataset.hidePicker).toBe('true');
  });
});
