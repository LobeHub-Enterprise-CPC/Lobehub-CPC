/**
 * @vitest-environment happy-dom
 */
import { HETEROGENEOUS_TYPE_LABELS } from '@lobechat/heterogeneous-agents';
import type { DeviceExecutionTarget } from '@lobechat/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import chat from '@/locales/default/chat';
import device from '@/locales/default/device';

import enChat from '../../../../../locales/en-US/chat.json';
import zhChat from '../../../../../locales/zh-CN/chat.json';
import zhDevice from '../../../../../locales/zh-CN/device.json';
import { ExecutionPlacePicker } from './ExecutionPlacePicker';

const chatDict = chat as Record<string, string>;
const deviceDict = device as Record<string, string>;
const enChatDict = enChat as Record<string, string>;
const zhChatDict = zhChat as Record<string, string>;
const zhDeviceDict = zhDevice as Record<string, string>;

const harness = vi.hoisted(() => ({
  calls: [] as Array<{ deviceId?: string; localSandbox?: boolean; target: string }>,
  directory: {
    clear: vi.fn(async () => undefined),
    commit: vi.fn(
      async (_entry: { path: string }, _options?: { localTarget?: boolean }) => undefined,
    ),
    deviceDefaultCwd: '/work',
    hasClearableSelection: true,
    recents: [{ path: '/work/app' }] as Array<{ path: string }>,
    selectedDir: '/work/app' as string | undefined,
    targetDeviceId: 'dev-1' as string | undefined,
  },
  isDesktop: true,
  model: {
    boundDeviceId: undefined as string | undefined,
    canShowExecutionTarget: true,
    canShowExecutionTargetSelector: true,
    chipExecutionTarget: 'local' as DeviceExecutionTarget | undefined,
    desktopDownload: { available: true, href: 'https://download.example/desktop' },
    executionTarget: 'local' as DeviceExecutionTarget | undefined,
    heteroType: 'claude-code' as string | undefined,
    localSandboxEnabled: false,
    showDesktopDownload: false,
    supportsSandbox: true,
  },
  pickedFolder: { path: '/work/picked', repoType: 'git' as const },
  pickModal: vi.fn(),
}));

vi.mock('@lobechat/const', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get isDesktop() {
    return harness.isDesktop;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = chatDict[key] ?? deviceDict[key] ?? key;
      return template.replaceAll(/\{\{(\w+)\}\}/g, (_, name: string) => String(opts?.[name] ?? ''));
    },
  }),
}));

vi.mock('@lobehub/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return {
    ...actual,
    Popover: ({
      children,
      content,
      onOpenChange,
      open,
    }: {
      children?: ReactNode;
      content?: ReactNode;
      onOpenChange?: (open: boolean) => void;
      open?: boolean;
    }) => (
      <div>
        <div data-testid={'execution-place-anchor'} onClick={() => onOpenChange?.(!open)}>
          {children}
        </div>
        {open ? <div data-testid={'execution-place-overlay'}>{content}</div> : null}
      </div>
    ),
    Tooltip: ({ children, title }: { children?: ReactNode; title?: ReactNode }) => (
      <div
        data-testid={'execution-place-tooltip'}
        data-title={typeof title === 'string' ? title : ''}
      >
        {children}
      </div>
    ),
  };
});

vi.mock('../useExecutionTargetController', async () => {
  const { useState } = await import('react');

  return {
    useExecutionTargetController: () => {
      const [, bump] = useState(0);
      const [open, setOpen] = useState(false);

      const selectTarget = async (
        target: DeviceExecutionTarget,
        deviceId?: string,
        localSandbox?: boolean,
      ) => {
        harness.calls.push({ deviceId, localSandbox, target });
        harness.model.executionTarget = target;
        harness.model.chipExecutionTarget = target;
        if (target === 'device') harness.model.boundDeviceId = deviceId;
        bump((value) => value + 1);
      };

      return {
        ...harness.model,
        open,
        selectTarget,
        setOpen,
      };
    },
  };
});

vi.mock('../useWorkingDirectoryController', () => ({
  useWorkingDirectoryController: () => harness.directory,
}));

vi.mock('../ExecutionTargetDeviceList', () => ({
  ExecutionTargetDeviceList: ({
    onSelectDevice,
  }: {
    onSelectDevice: (deviceId: string) => void;
  }) => (
    <button
      data-testid={'execution-place-device-row'}
      type={'button'}
      onClick={() => onSelectDevice('dev-9')}
    >
      remote-device
    </button>
  ),
}));

vi.mock('@/services/electron/system', () => ({
  electronSystemService: {
    selectFolder: vi.fn(async () => harness.pickedFolder),
  },
}));

vi.mock('@/features/WorkingDirectory', () => ({
  openPickWorkingDirModal: (...args: unknown[]) => harness.pickModal(...args),
}));

const openMenu = () => {
  fireEvent.click(screen.getByTestId('execution-place-trigger'));
};

describe('execution place copy', () => {
  it('keeps the design copy in zh-CN and the English source in en-US', () => {
    expect(zhChatDict['heteroAgent.executionPlace.local']).toBe('本地设备');
    expect(zhChatDict['heteroAgent.executionPlace.localDesc']).toBe('在当前电脑上运行');
    expect(zhChatDict['heteroAgent.executionPlace.localDesktopOnly']).toBe('需在桌面端使用');
    expect(zhChatDict['heteroAgent.executionPlace.cloud']).toBe('云端');
    expect(zhChatDict['heteroAgent.executionPlace.cloudDesc']).toBe('由云端托管运行');
    expect(zhChatDict['heteroAgent.executionPlace.remote']).toBe('远程');
    expect(zhChatDict['heteroAgent.executionPlace.remoteDesc']).toBe('连接远端设备运行');
    expect(zhDeviceDict['workingDirectory.recent']).toBe('工作目录');
    expect(zhDeviceDict['workingDirectory.clear']).toBe('恢复默认');
    expect(zhDeviceDict['workingDirectory.chooseDifferentFolder']).toBe('选择其他文件夹');

    for (const key of [
      'heteroAgent.executionPlace.local',
      'heteroAgent.executionPlace.localDesc',
      'heteroAgent.executionPlace.localDesktopOnly',
      'heteroAgent.executionPlace.cloud',
      'heteroAgent.executionPlace.cloudDesc',
      'heteroAgent.executionPlace.remote',
      'heteroAgent.executionPlace.remoteDesc',
    ]) {
      expect(enChatDict[key]).toBe(chatDict[key]);
    }
  });
});

describe('ExecutionPlacePicker', () => {
  beforeEach(() => {
    harness.calls = [];
    harness.isDesktop = true;
    harness.directory.clear.mockClear();
    harness.directory.commit.mockClear();
    harness.directory.hasClearableSelection = true;
    harness.directory.recents = [{ path: '/work/app' }];
    harness.directory.selectedDir = '/work/app';
    harness.directory.targetDeviceId = 'dev-1';
    harness.model.boundDeviceId = undefined;
    harness.model.canShowExecutionTarget = true;
    harness.model.canShowExecutionTargetSelector = true;
    harness.model.chipExecutionTarget = 'local';
    harness.model.executionTarget = 'local';
    harness.model.heteroType = 'claude-code';
    harness.model.localSandboxEnabled = false;
    harness.model.showDesktopDownload = false;
    harness.model.supportsSandbox = true;
    harness.pickModal.mockClear();
  });

  it('shows three places and checks only the current one', () => {
    render(<ExecutionPlacePicker agentId={'agent-1'} />);
    openMenu();

    expect(screen.getByTestId('execution-place-item-local')).toHaveTextContent('Local device');
    expect(screen.getByTestId('execution-place-item-local')).toHaveTextContent(
      'Run on this computer',
    );
    expect(screen.getByTestId('execution-place-item-cloud')).toHaveTextContent('Cloud');
    expect(screen.getByTestId('execution-place-item-cloud')).toHaveTextContent(
      'Hosted in the cloud',
    );
    expect(screen.getByTestId('execution-place-item-remote')).toHaveTextContent('Remote');
    expect(screen.getByTestId('execution-place-item-remote')).toHaveTextContent(
      'Connect a remote device',
    );
    expect(screen.getByTestId('execution-place-check-local')).toBeTruthy();
    expect(screen.queryByTestId('execution-place-check-cloud')).toBeNull();
    expect(screen.queryByTestId('execution-place-check-remote')).toBeNull();
    expect(screen.queryByText('heteroAgent.executionTarget.none')).toBeNull();
    expect(screen.queryByText('heteroAgent.executionTarget.auto')).toBeNull();
  });

  it.each(['none', 'auto', 'sandbox'] as const)(
    'maps stored %s onto the cloud icon without rewriting it',
    (target) => {
      harness.model.chipExecutionTarget = target;
      harness.model.executionTarget = target;

      render(<ExecutionPlacePicker agentId={'agent-1'} />);

      const trigger = screen.getByTestId('execution-place-trigger');
      expect(trigger.dataset.place).toBe('cloud');
      expect(trigger).toHaveAttribute('aria-label', 'Cloud');
      expect(screen.getByTestId('execution-place-tooltip')).toHaveAttribute('data-title', 'Cloud');
      expect(harness.calls).toEqual([]);
    },
  );

  it('keeps a fenced local run on the local icon and does not rewrite the flag', () => {
    harness.model.localSandboxEnabled = true;
    harness.model.chipExecutionTarget = 'local';
    harness.model.executionTarget = 'local';

    render(<ExecutionPlacePicker agentId={'agent-1'} />);

    expect(screen.getByTestId('execution-place-trigger').dataset.place).toBe('local');
    openMenu();
    fireEvent.click(screen.getByTestId('execution-place-item-local'));
    expect(harness.calls).toEqual([]);
  });

  it('opens the working-directory panel beside local and commits through the shared controller', async () => {
    render(<ExecutionPlacePicker agentId={'agent-1'} />);
    openMenu();

    expect(screen.getByTestId('execution-place-directory')).toHaveTextContent('Working directory');
    expect(screen.getByTestId('execution-place-restore-default')).toHaveTextContent(
      'Reset to default',
    );
    expect(screen.getByTestId('execution-place-dir-/work/app')).toHaveAttribute(
      'data-active',
      'true',
    );
    expect(screen.getByTestId('choose-local-folder')).toHaveTextContent('Choose a folder...');

    fireEvent.click(screen.getByTestId('execution-place-dir-/work/app'));
    await waitFor(() =>
      expect(harness.directory.commit).toHaveBeenCalledWith({ path: '/work/app' }),
    );
    expect(harness.calls).toEqual([]);
    expect(screen.queryByTestId('execution-place-overlay')).toBeNull();
  });

  it('selects local, then commits, when a directory is picked from another place', async () => {
    harness.model.chipExecutionTarget = 'sandbox';
    harness.model.executionTarget = 'sandbox';

    render(<ExecutionPlacePicker agentId={'agent-1'} />);
    openMenu();
    fireEvent.mouseEnter(screen.getByTestId('execution-place-item-local'));
    fireEvent.click(screen.getByTestId('execution-place-dir-/work/app'));

    await waitFor(() =>
      expect(harness.calls).toEqual([
        { deviceId: undefined, localSandbox: undefined, target: 'local' },
      ]),
    );
    expect(harness.directory.commit).toHaveBeenCalledWith(
      { path: '/work/app' },
      { localTarget: true },
    );
  });

  it('clears the directory with the existing restore action', async () => {
    render(<ExecutionPlacePicker agentId={'agent-1'} />);
    openMenu();
    fireEvent.click(screen.getByTestId('execution-place-restore-default'));

    await waitFor(() => expect(harness.directory.clear).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('execution-place-overlay')).toBeNull();
  });

  it('lists remote devices and shows that device directory only after one is selected', () => {
    harness.model.chipExecutionTarget = 'sandbox';
    harness.model.executionTarget = 'sandbox';

    render(<ExecutionPlacePicker agentId={'agent-1'} />);
    openMenu();
    fireEvent.click(screen.getByTestId('execution-place-item-remote'));

    expect(screen.getByTestId('execution-place-devices')).toBeTruthy();
    expect(screen.queryByTestId('execution-place-directory')).toBeNull();

    fireEvent.click(screen.getByTestId('execution-place-device-row'));

    expect(harness.calls).toEqual([
      { deviceId: 'dev-9', localSandbox: undefined, target: 'device' },
    ]);
    expect(screen.getByTestId('execution-place-directory')).toBeTruthy();
    expect(screen.getByTestId('add-remote-folder')).toBeTruthy();
    expect(screen.queryByTestId('choose-local-folder')).toBeNull();
  });

  it('opens the remote folder browser for the selected device', () => {
    harness.model.chipExecutionTarget = 'device';
    harness.model.executionTarget = 'device';
    harness.model.boundDeviceId = 'dev-9';

    render(<ExecutionPlacePicker agentId={'agent-1'} />);
    openMenu();
    fireEvent.click(screen.getByTestId('add-remote-folder'));

    expect(harness.pickModal).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: '/work/app', deviceId: 'dev-1' }),
    );
  });

  it('switches to the cloud sandbox and closes the menu', async () => {
    harness.model.chipExecutionTarget = 'local';
    harness.model.executionTarget = 'local';

    render(<ExecutionPlacePicker agentId={'agent-1'} />);
    openMenu();
    fireEvent.click(screen.getByTestId('execution-place-item-cloud'));

    await waitFor(() =>
      expect(harness.calls).toEqual([
        { deviceId: undefined, localSandbox: undefined, target: 'sandbox' },
      ]),
    );
    expect(screen.queryByTestId('execution-place-overlay')).toBeNull();
    expect(screen.queryByTestId('execution-place-directory')).toBeNull();
  });

  it('does not rewrite an execution target that is already the cloud sandbox', () => {
    harness.model.chipExecutionTarget = 'sandbox';
    harness.model.executionTarget = 'sandbox';

    render(<ExecutionPlacePicker agentId={'agent-1'} />);
    openMenu();
    fireEvent.click(screen.getByTestId('execution-place-item-cloud'));

    expect(harness.calls).toEqual([]);
    expect(screen.queryByTestId('execution-place-overlay')).toBeNull();
  });

  it('disables cloud when the CLI cannot use a sandbox and explains why', () => {
    harness.model.supportsSandbox = false;
    harness.model.chipExecutionTarget = 'local';

    render(<ExecutionPlacePicker agentId={'agent-1'} />);
    openMenu();

    const cloud = screen.getByTestId('execution-place-item-cloud');
    expect(cloud).toBeDisabled();
    expect(cloud).toHaveTextContent(HETEROGENEOUS_TYPE_LABELS['claude-code']);
    fireEvent.click(cloud);
    expect(harness.calls).toEqual([]);
  });

  it('disables local on the web and offers the desktop download', () => {
    harness.isDesktop = false;
    harness.model.showDesktopDownload = true;
    harness.model.chipExecutionTarget = 'sandbox';
    harness.model.executionTarget = 'sandbox';

    render(<ExecutionPlacePicker agentId={'agent-1'} />);
    openMenu();

    const local = screen.getByTestId('execution-place-item-local');
    expect(local).toHaveAttribute('aria-disabled', 'true');
    expect(local).toHaveTextContent('Available in the desktop app');
    expect(screen.getByTestId('execution-place-desktop-download')).toHaveAttribute(
      'href',
      'https://download.example/desktop',
    );
    expect(screen.queryByTestId('execution-place-directory')).toBeNull();
    fireEvent.click(local);
    expect(harness.calls).toEqual([]);
  });

  it('stays closed and explains the lock when the member cannot choose a place', () => {
    harness.model.canShowExecutionTargetSelector = false;

    render(<ExecutionPlacePicker agentId={'agent-1'} />);

    const trigger = screen.getByTestId('execution-place-trigger');
    expect(trigger.dataset.readonly).toBe('true');
    fireEvent.click(trigger);
    expect(screen.queryByTestId('execution-place-menu')).toBeNull();
    expect(screen.getByTestId('execution-place-tooltip').dataset.title).toContain(
      'fixed in the Agent Profile',
    );
  });

  it('renders nothing when the member cannot see the execution target', () => {
    harness.model.canShowExecutionTarget = false;

    render(<ExecutionPlacePicker agentId={'agent-1'} />);

    expect(screen.queryByTestId('execution-place-trigger')).toBeNull();
  });

  it('lets a use-only member change place but not the directory', () => {
    harness.model.chipExecutionTarget = 'sandbox';
    harness.model.executionTarget = 'sandbox';

    render(<ExecutionPlacePicker agentId={'agent-1'} allowDirectory={false} />);
    openMenu();
    fireEvent.click(screen.getByTestId('execution-place-item-local'));
    fireEvent.click(screen.getByTestId('execution-place-item-remote'));

    expect(harness.calls).toEqual([
      { deviceId: undefined, localSandbox: undefined, target: 'local' },
    ]);
    expect(screen.queryByTestId('execution-place-directory')).toBeNull();
    expect(screen.getByTestId('execution-place-devices')).toBeTruthy();
  });

  it('puts the current directory on the tooltip while the menu is closed', () => {
    render(<ExecutionPlacePicker agentId={'agent-1'} />);

    expect(screen.getByTestId('execution-place-tooltip')).toHaveAttribute(
      'data-title',
      'Local device · /work/app',
    );
    // The tooltip wrapper stays mounted while the menu is open (so the popover
    // anchor never remounts); it is forced shut instead of being unmounted.
    openMenu();
    expect(screen.getByTestId('execution-place-tooltip')).toHaveAttribute(
      'data-title',
      'Local device · /work/app',
    );
    expect(screen.getByTestId('execution-place-item-local')).toBeTruthy();
  });
});
