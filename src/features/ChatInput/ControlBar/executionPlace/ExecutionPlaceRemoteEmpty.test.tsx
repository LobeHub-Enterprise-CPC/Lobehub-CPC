/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import chat from '@/locales/default/chat';
import device from '@/locales/default/device';

import { ExecutionTargetDeviceList } from '../ExecutionTargetDeviceList';
import type { ExecutionTargetController } from '../useExecutionTargetController';
import { ExecutionPlaceRemoteEmpty } from './ExecutionPlaceRemoteEmpty';

const chatDict = chat as Record<string, string>;
const deviceDict = device as Record<string, string>;

const harness = vi.hoisted(() => ({
  isDesktop: true,
  refreshDevices: vi.fn(async () => undefined),
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

const stubModel = (overrides: Partial<ExecutionTargetController> = {}): ExecutionTargetController =>
  ({
    agentWorkspaceId: 'ws-1',
    cliBin: 'lh',
    desktopDownload: { available: true, href: 'https://download.example/desktop' },
    deviceRows: [],
    isPoolEmpty: true,
    isWorkspaceAgent: false,
    personalOnlyDevices: [],
    poolStatus: 'empty',
    privateDevices: [],
    refreshDevices: harness.refreshDevices,
    showDeviceGroups: false,
    showWebDownloadCard: false,
    showWorkspaceEnrollHint: false,
    workspaceDevices: [],
    ...overrides,
  }) as unknown as ExecutionTargetController;

describe('ExecutionPlaceRemoteEmpty', () => {
  beforeEach(() => {
    harness.isDesktop = true;
    harness.refreshDevices.mockClear();
  });

  it('renders the loading state', () => {
    render(<ExecutionPlaceRemoteEmpty model={stubModel({ poolStatus: 'loading' })} />);

    expect(screen.getByTestId('execution-place-remote-loading')).toHaveTextContent(
      'Loading devices…',
    );
  });

  it('renders the load-failed state and retries through the controller', () => {
    render(<ExecutionPlaceRemoteEmpty model={stubModel({ poolStatus: 'error' })} />);

    expect(screen.getByTestId('execution-place-remote-load-failed')).toHaveTextContent(
      'Couldn’t load devices.',
    );
    fireEvent.click(screen.getByTestId('execution-place-remote-retry'));
    expect(harness.refreshDevices).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'personal pool is empty',
      stubModel({
        isPoolEmpty: true,
        isWorkspaceAgent: false,
        poolStatus: 'empty',
        showWebDownloadCard: false,
        showWorkspaceEnrollHint: false,
      }),
    ],
    [
      'workspace agent has no workspace devices',
      stubModel({
        isPoolEmpty: true,
        isWorkspaceAgent: true,
        poolStatus: 'empty',
        showWorkspaceEnrollHint: true,
      }),
    ],
    [
      'web can offer a desktop download',
      stubModel({
        isPoolEmpty: true,
        poolStatus: 'empty',
        showWebDownloadCard: true,
      }),
    ],
    [
      'pool status matches nothing else',
      {
        ...stubModel({
          deviceRows: [],
          isPoolEmpty: false,
          showWebDownloadCard: false,
          showWorkspaceEnrollHint: false,
        }),
        poolStatus: 'idle' as ExecutionTargetController['poolStatus'],
      },
    ],
  ])('renders the same empty placeholder when %s', (_label, model) => {
    const { container } = render(<ExecutionPlaceRemoteEmpty model={model} />);

    const panel = screen.getByTestId('execution-place-remote-empty');
    expect(container).not.toBeEmptyDOMElement();
    expect(panel).toHaveTextContent(/^No remote devices$/);
    expect(panel).not.toHaveTextContent('connect');
    expect(panel).not.toHaveTextContent('Get the desktop app');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByTestId('execution-place-remote-copy-command')).toBeNull();
    expect(screen.queryByTestId('execution-place-remote-download')).toBeNull();
  });

  it.each([
    [
      'the pool is confirmed',
      stubModel({ deviceRows: [], isPoolEmpty: false, poolStatus: 'devices' }),
    ],
    [
      'rows are already listed',
      stubModel({
        deviceRows: [{ deviceId: 'dev-1' } as ExecutionTargetController['deviceRows'][number]],
        isPoolEmpty: false,
        poolStatus: 'empty',
        showWebDownloadCard: true,
        showWorkspaceEnrollHint: true,
      }),
    ],
  ])('renders nothing once %s', (_label, model) => {
    const { container } = render(<ExecutionPlaceRemoteEmpty model={model} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('execution-place-remote-empty')).toBeNull();
  });
});

describe('ExecutionTargetDeviceList empty variants', () => {
  beforeEach(() => {
    harness.isDesktop = true;
    harness.refreshDevices.mockClear();
  });

  it('uses the panel empty state when emptyVariant is panel', () => {
    render(
      <ExecutionTargetDeviceList
        emptyVariant={'panel'}
        model={stubModel({ poolStatus: 'loading' })}
        onSelectDevice={() => undefined}
      />,
    );

    expect(screen.getByTestId('execution-place-remote-loading')).toBeTruthy();
  });

  it('keeps the legacy menu empty state by default', () => {
    render(
      <ExecutionTargetDeviceList
        model={stubModel({ poolStatus: 'loading' })}
        onSelectDevice={() => undefined}
      />,
    );

    expect(screen.queryByTestId('execution-place-remote-loading')).toBeNull();
    expect(screen.getByText('Loading devices…')).toBeTruthy();
  });
});
