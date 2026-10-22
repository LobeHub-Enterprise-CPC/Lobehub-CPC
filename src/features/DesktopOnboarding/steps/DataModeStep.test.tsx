import { ConfigProvider } from '@lobehub/ui';
import { en } from '@lobehub/ui/i18n';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { motion } from 'motion/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { userService } from '@/services/user';
import { useUserStore } from '@/store/user';

import DataModeStep from './DataModeStep';

vi.mock('../components/LobeMessage', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const originalUserState = useUserStore.getState();
const saveResult: Awaited<ReturnType<typeof userService.updateUserSettings>> = {
  command: 'UPDATE',
  fields: [],
  oid: 0,
  rowCount: 1,
  rows: [],
};
afterEach(() => {
  cleanup();
  useUserStore.setState(originalUserState);
  vi.restoreAllMocks();
});

describe('desktop privacy preference persistence', () => {
  it('shows failed optimistic saves, blocks continuing, and retries the same selection', async () => {
    useUserStore.setState({
      settings: { general: { telemetry: true } },
      refreshUserState: vi.fn().mockResolvedValue(undefined),
    });
    const save = vi
      .spyOn(userService, 'updateUserSettings')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(saveResult);
    const onNext = vi.fn();
    render(
      <ConfigProvider locale={'en'} motion={motion} resources={en}>
        <DataModeStep onBack={vi.fn()} onNext={onNext} />
      </ConfigProvider>,
    );

    fireEvent.click(screen.getByText('screen4.privacy.title'));
    await screen.findByRole('alert');
    // Drive the actual settings action: its optimistic value already matches
    // the selection, so a retry must still call through and persist it.
    expect(useUserStore.getState().settings.general?.telemetry).toBe(false);
    expect(screen.getByRole('button', { name: 'next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'back' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'next' }));
    expect(onNext).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toMatchObject({ general: { telemetry: false } });
    fireEvent.click(screen.getByRole('button', { name: 'next' }));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('does not continue or send duplicate choices while the save is pending', async () => {
    useUserStore.setState({
      settings: { general: { telemetry: true } },
      refreshUserState: vi.fn().mockResolvedValue(undefined),
    });
    let resolve!: (value: typeof saveResult) => void;
    const save = vi.spyOn(userService, 'updateUserSettings').mockImplementation(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const onNext = vi.fn();
    render(
      <ConfigProvider locale={'en'} motion={motion} resources={en}>
        <DataModeStep onBack={vi.fn()} onNext={onNext} />
      </ConfigProvider>,
    );
    fireEvent.click(screen.getByText('screen4.privacy.title'));
    fireEvent.click(screen.getByText('screen4.share.title'));
    fireEvent.click(screen.getByRole('button', { name: 'next' }));
    expect(save).toHaveBeenCalledOnce();
    expect(onNext).not.toHaveBeenCalled();
    await act(async () => resolve(saveResult));
    expect(screen.getByRole('button', { name: 'next' })).toBeEnabled();
  });
});
