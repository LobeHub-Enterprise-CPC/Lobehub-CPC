/**
 * @vitest-environment happy-dom
 */
import type { DeviceExecutionTarget } from '@lobechat/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import chat from '@/locales/default/chat';
import device from '@/locales/default/device';

import { ExecutionPlacePicker } from './ExecutionPlacePicker';

const chatDict = chat as Record<string, string>;
const deviceDict = device as Record<string, string>;

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
    agentWorkspaceId: undefined as string | undefined,
    boundDeviceId: undefined as string | undefined,
    canShowExecutionTarget: true,
    canShowExecutionTargetSelector: true,
    chipExecutionTarget: 'local' as DeviceExecutionTarget | undefined,
    cliBin: 'lh',
    desktopDownload: { available: true, href: 'https://download.example/desktop' },
    deviceRows: [] as Array<{ deviceId: string }>,
    executionTarget: 'local' as DeviceExecutionTarget | undefined,
    heteroType: 'claude-code' as string | undefined,
    isPoolEmpty: false,
    isWorkspaceAgent: false,
    localSandboxEnabled: false,
    personalOnlyDevices: [] as Array<{ deviceId: string }>,
    poolStatus: 'devices' as 'devices' | 'empty' | 'error' | 'loading',
    privateDevices: [] as Array<{ deviceId: string }>,
    refreshDevices: vi.fn(async () => undefined),
    showDesktopDownload: false,
    showDeviceGroups: false,
    showWebDownloadCard: false,
    showWorkspaceEnrollHint: false,
    supportsSandbox: true,
    workspaceDevices: [] as Array<{ deviceId: string }>,
  },
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

// NOTE: @lobehub/ui is intentionally NOT mocked here. These cases prove the
// trigger talks to the real Popover: one click opens, the anchor is never
// remounted, and outside presses close the menu.
vi.mock('../useExecutionTargetController', async () => {
  const { useState } = await import('react');

  return {
    useExecutionTargetController: () => {
      const [open, setOpen] = useState(false);

      const selectTarget = async (
        target: DeviceExecutionTarget,
        deviceId?: string,
        localSandbox?: boolean,
      ) => {
        harness.calls.push({ deviceId, localSandbox, target });
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

vi.mock('@/services/electron/system', () => ({
  electronSystemService: {
    selectFolder: vi.fn(async () => undefined),
  },
}));

vi.mock('@/features/WorkingDirectory', () => ({
  openPickWorkingDirModal: vi.fn(),
}));

describe('ExecutionPlacePicker with the real Popover', () => {
  beforeEach(() => {
    harness.calls = [];
    harness.isDesktop = true;
    harness.directory.hasClearableSelection = true;
    harness.directory.recents = [{ path: '/work/app' }];
    harness.directory.selectedDir = '/work/app';
    harness.model.poolStatus = 'devices';
  });

  it('opens the menu with a single click on the same trigger node', async () => {
    render(<ExecutionPlacePicker agentId={'agent-1'} />);

    const trigger = screen.getByTestId('execution-place-trigger');
    fireEvent.click(trigger);

    expect(await screen.findByTestId('execution-place-item-local')).toBeTruthy();
    expect(await screen.findByTestId('execution-place-item-cloud')).toBeTruthy();
    expect(await screen.findByTestId('execution-place-item-remote')).toBeTruthy();
    // The anchor must survive the open transition: a remounted trigger is the
    // double-click bug (the opening click replaces its own anchor).
    expect(screen.getByTestId('execution-place-trigger')).toBe(trigger);
  });

  it('closes the menu with a second click on the trigger', async () => {
    render(<ExecutionPlacePicker agentId={'agent-1'} />);

    const trigger = screen.getByTestId('execution-place-trigger');
    fireEvent.click(trigger);
    expect(await screen.findByTestId('execution-place-item-local')).toBeTruthy();

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByTestId('execution-place-item-local')).toBeNull());
    expect(screen.getByTestId('execution-place-trigger')).toBe(trigger);
  });

  it('closes the menu when pressing outside of it', async () => {
    render(<ExecutionPlacePicker agentId={'agent-1'} />);

    fireEvent.click(screen.getByTestId('execution-place-trigger'));
    expect(await screen.findByTestId('execution-place-item-local')).toBeTruthy();

    // Base UI dismisses on an intentional outside press (press starts and ends
    // outside the popup), so both events are needed.
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    await waitFor(() => expect(screen.queryByTestId('execution-place-item-local')).toBeNull());
  });

  it.each(['left', 'right'] as const)(
    'opens the cascade beside the menu on the %s without widening the popup',
    async (placement) => {
      render(<ExecutionPlacePicker agentId={'agent-1'} placement={placement} />);

      fireEvent.click(screen.getByTestId('execution-place-trigger'));

      // Local is current on desktop, so the directory cascade opens with the
      // menu, in its own positioned layer beside the in-flow menu card.
      const side = await screen.findByTestId('execution-place-side');
      expect(side.dataset.placement).toBe(placement);
      expect(
        side.nextElementSibling?.contains(screen.getByTestId('execution-place-item-local')),
      ).toBe(true);
    },
  );
});
