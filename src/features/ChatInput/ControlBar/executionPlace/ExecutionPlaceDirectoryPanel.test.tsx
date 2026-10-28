/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import chat from '@/locales/default/chat';
import device from '@/locales/default/device';

import { ExecutionPlaceDirectoryPanel } from './ExecutionPlaceDirectoryPanel';

const chatDict = chat as Record<string, string>;
const deviceDict = device as Record<string, string>;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = chatDict[key] ?? deviceDict[key] ?? key;
      return template.replaceAll(/\{\{(\w+)\}\}/g, (_, name: string) => String(opts?.[name] ?? ''));
    },
  }),
}));

vi.mock('@/services/electron/system', () => ({
  electronSystemService: {
    selectFolder: vi.fn(async () => undefined),
  },
}));

vi.mock('@/features/WorkingDirectory', () => ({
  openPickWorkingDirModal: vi.fn(),
}));

const noop = () => undefined;

describe('ExecutionPlaceDirectoryPanel without recent directories', () => {
  it('shows a hint and the choose-folder row instead of an empty list', () => {
    render(
      <ExecutionPlaceDirectoryPanel
        isLocal
        hasClearableSelection={false}
        recents={[]}
        onClear={noop}
        onClose={noop}
        onPick={noop}
      />,
    );

    expect(screen.getByTestId('execution-place-no-recent-dirs')).toHaveTextContent(
      'No recently used directories yet',
    );
    // No clear action without a clearable selection, and no empty list block.
    expect(screen.queryByTestId('execution-place-restore-default')).toBeNull();
    expect(screen.queryByTestId(/^execution-place-dir-/)).toBeNull();
    expect(screen.getByTestId('choose-local-folder')).toHaveTextContent('Choose a folder...');
  });

  it('keeps the restore action when the selection is clearable but recents are gone', () => {
    render(
      <ExecutionPlaceDirectoryPanel
        hasClearableSelection
        isLocal
        recents={[]}
        onClear={noop}
        onClose={noop}
        onPick={noop}
      />,
    );

    expect(screen.getByTestId('execution-place-restore-default')).toHaveTextContent(
      'Reset to default',
    );
    expect(screen.getByTestId('execution-place-no-recent-dirs')).toBeTruthy();
  });

  it('shows the remote add-folder row without recents', () => {
    render(
      <ExecutionPlaceDirectoryPanel
        hasClearableSelection={false}
        isLocal={false}
        recents={[]}
        targetDeviceId={'dev-1'}
        onClear={noop}
        onClose={noop}
        onPick={noop}
      />,
    );

    expect(screen.getByTestId('execution-place-no-recent-dirs')).toBeTruthy();
    expect(screen.getByTestId('add-remote-folder')).toHaveTextContent('Choose a folder...');
  });

  it('renders rows and the restore action when recents exist', () => {
    render(
      <ExecutionPlaceDirectoryPanel
        hasClearableSelection
        isLocal
        recents={[{ path: '/work/app' }]}
        selectedDir={'/work/app'}
        onClear={noop}
        onClose={noop}
        onPick={noop}
      />,
    );

    expect(screen.getByTestId('execution-place-dir-/work/app')).toBeTruthy();
    expect(screen.queryByTestId('execution-place-no-recent-dirs')).toBeNull();
    expect(screen.getByTestId('execution-place-restore-default')).toBeTruthy();
  });
});
