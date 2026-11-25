/**
 * @vitest-environment happy-dom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useModelFavorites } from './useModelFavorites';

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, any>,
  workspaceId: null as string | null,
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  useActiveWorkspaceId: () => mocks.workspaceId,
}));
vi.mock('@/store/user', () => {
  const useUserStore = (selector: (s: any) => unknown) => selector(mocks.state);
  useUserStore.getState = () => mocks.state;
  return { useUserStore };
});

beforeEach(() => {
  mocks.workspaceId = null;
  mocks.state = {
    preference: { favoriteModels: ['lobehub/personal'] },
    updatePreference: vi.fn(async (patch: object) => {
      mocks.state = { ...mocks.state, preference: { ...mocks.state.preference, ...patch } };
    }),
    updateWorkspaceUserPreference: vi.fn(async () => {}),
    useFetchWorkspaceUserPreference: () => ({}),
    workspaceUserPreference: { favoriteModels: ['lobehub/team'] },
    workspaceUserPreferenceWorkspaceId: 'ws-1',
  };
});

describe('useModelFavorites', () => {
  it('keeps personal stars in the personal preference', async () => {
    const { result } = renderHook(() => useModelFavorites());
    expect(result.current.favorites).toEqual(['lobehub/personal']);

    await act(() => result.current.setFavorite('b', ['lobehub'], true));
    expect(mocks.state.updatePreference).toHaveBeenCalledWith({
      favoriteModels: ['lobehub/personal', 'lobehub/b'],
    });
    expect(mocks.state.updateWorkspaceUserPreference).not.toHaveBeenCalled();
  });

  it('keeps a workspace apart from the personal stars', async () => {
    mocks.workspaceId = 'ws-1';
    const { result } = renderHook(() => useModelFavorites());
    expect(result.current.favorites).toEqual(['lobehub/team']);
    expect(result.current.isFavorite('personal', ['lobehub'])).toBe(false);

    await act(() => result.current.setFavorite('b', ['lobehub'], true));
    expect(mocks.state.updateWorkspaceUserPreference).toHaveBeenCalledWith({
      favoriteModels: ['lobehub/team', 'lobehub/b'],
    });
    expect(mocks.state.updatePreference).not.toHaveBeenCalled();
  });

  it('adds to the latest stars when two are set before a re-render', async () => {
    const { result } = renderHook(() => useModelFavorites());
    const { setFavorite } = result.current;
    await act(async () => {
      await setFavorite('b', ['lobehub'], true);
      await setFavorite('c', ['lobehub'], true);
    });
    expect(mocks.state.preference.favoriteModels).toEqual([
      'lobehub/personal',
      'lobehub/b',
      'lobehub/c',
    ]);
  });

  it('stars the first provider of a row and clears all of them', async () => {
    mocks.state.preference = { favoriteModels: ['openai/a', 'lobehub/keep'] };
    const { result } = renderHook(() => useModelFavorites());
    expect(result.current.isFavorite('a', ['lobehub', 'openai'])).toBe(true);

    await act(() => result.current.setFavorite('a', ['lobehub', 'openai'], false));
    expect(mocks.state.updatePreference).toHaveBeenLastCalledWith({
      favoriteModels: ['lobehub/keep'],
    });
    await act(() => result.current.setFavorite('a', ['lobehub', 'openai'], true));
    expect(mocks.state.updatePreference).toHaveBeenLastCalledWith({
      favoriteModels: ['lobehub/keep', 'lobehub/a'],
    });
  });
});
