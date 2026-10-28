/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import WorkingDirectorySection from './WorkingDirectorySection';

const flags = vi.hoisted(() => ({
  stagedDirectoryId: undefined as string | undefined,
  topicId: 'topic-1' as string | null,
}));

vi.mock('@/hooks/useEffectiveAgencyConfig', () => ({
  useEffectiveAgencyConfig: () => ({ agencyConfig: {}, workspaceScoped: false }),
}));

vi.mock('@/hooks/useEffectiveWorkingDirectory', () => ({
  useEffectiveWorkingDirectory: () => '/work/app',
}));

vi.mock('../hooks/useTopicId', () => ({
  useTopicId: () => flags.topicId,
}));

vi.mock('@/store/chat', () => ({
  useChatStore: (selector: (state: object) => unknown) => selector({}),
}));

vi.mock('@/store/chat/selectors', () => ({
  topicSelectors: {
    getTopicById: () => () => ({
      metadata: { workingDirectoryConfig: { path: '/work/app', repoType: 'git' } },
    }),
  },
}));

vi.mock('@/store/device', () => ({
  deviceSelectors: {
    getDeviceWorkingDirs: () => () => [],
  },
  useDeviceStore: (selector: (state: object) => unknown) => selector({}),
}));

vi.mock('@/store/electron', () => ({
  useElectronStore: (selector: (state: { gatewayDeviceInfo?: { deviceId?: string } }) => unknown) =>
    selector({}),
}));

vi.mock('./useRepoType', () => ({
  useRepoType: () => undefined,
}));

vi.mock('./useProjectTopicDirectory', () => ({
  useActiveProjectDirectoryTopicId: () => undefined,
  useStagedProjectDirectoryId: () => flags.stagedDirectoryId,
}));

vi.mock('./WorkingDirectoryPicker', () => ({
  default: () => <div data-testid={'working-directory-picker'} />,
}));

vi.mock('./GitStatus', () => ({
  default: () => <div data-testid={'git-status'} />,
}));

describe('WorkingDirectorySection', () => {
  beforeEach(() => {
    flags.stagedDirectoryId = undefined;
    flags.topicId = 'topic-1';
  });

  it('shows the directory picker and the git chips together', () => {
    render(<WorkingDirectorySection agentId={'agent-1'} />);

    expect(screen.getByTestId('working-directory-picker')).toBeTruthy();
    expect(screen.getByTestId('git-status')).toBeTruthy();
  });

  it('hides the picker and keeps the git chips when the place picker owns the directory', () => {
    render(<WorkingDirectorySection hidePicker agentId={'agent-1'} />);

    expect(screen.queryByTestId('working-directory-picker')).toBeNull();
    expect(screen.getByTestId('git-status')).toBeTruthy();
  });

  it('renders nothing for a staged project directory', () => {
    flags.stagedDirectoryId = 'dir-1';

    render(<WorkingDirectorySection agentId={'agent-1'} />);

    expect(screen.queryByTestId('working-directory-picker')).toBeNull();
    expect(screen.queryByTestId('git-status')).toBeNull();
  });
});
