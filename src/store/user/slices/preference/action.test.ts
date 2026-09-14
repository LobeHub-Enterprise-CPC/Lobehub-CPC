import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SWR from '@/libs/swr';
import { mutate } from '@/libs/swr';
import { userService } from '@/services/user';
import { useUserStore } from '@/store/user';
import { type UserGuide } from '@/types/user';

vi.mock('@/libs/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof SWR>()),
  mutate: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createPreferenceSlice', () => {
  it('revalidates Channel availability only after the Labs opt-in is persisted', async () => {
    let saved!: () => void;
    vi.spyOn(userService, 'updatePreference').mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          saved = () => resolve(undefined);
        }),
    );
    const updating = useUserStore.getState().updateLab({ enableChannel: true });
    expect(userService.updatePreference).toHaveBeenCalledWith(
      expect.objectContaining({ lab: expect.objectContaining({ enableChannel: true }) }),
    );
    expect(mutate).not.toHaveBeenCalled();
    saved();
    await updating;
    expect(mutate).toHaveBeenCalledWith('channel-availability');
  });

  describe('updateGuideState', () => {
    it('should update guide state', () => {
      const { result } = renderHook(() => useUserStore());
      const guide: UserGuide = { topic: true };

      act(() => {
        result.current.updateGuideState(guide);
      });

      expect(result.current.preference.guide!.topic).toBeTruthy();
    });
  });

  describe('updatePreference', () => {
    it('should update preference', () => {
      const { result } = renderHook(() => useUserStore());

      act(() => {
        result.current.updatePreference({ hideSyncAlert: true });
      });

      expect(result.current.preference.hideSyncAlert).toEqual(true);
    });
  });
});
