import isEqual from 'fast-deep-equal';
import { useCallback, useMemo } from 'react';

import { useActiveWorkspaceId } from '@/business/client/hooks/useActiveWorkspaceId';
import { useUserStore } from '@/store/user';
import { workspaceUserSettingsSelectors } from '@/store/user/slices/workspaceUserSettings/selectors';
import { type UserStore } from '@/store/user/store';

import { type ModelFavorites } from '../components/List/modelFavoritesContext';
import { favoriteModelKey } from '../utils';

const EMPTY: string[] = [];

/** The caller's stars in the active workspace, or their personal ones outside any workspace. */
const favoritesOf = (workspaceId: string | null) => (s: UserStore) =>
  workspaceId
    ? workspaceUserSettingsSelectors.favoriteModels(workspaceId)(s)
    : (s.preference.favoriteModels ?? EMPTY);

/**
 * Stars are a personal preference kept per workspace: they reorder this member's own picker and
 * never touch which models are enabled.
 */
export const useModelFavorites = (): ModelFavorites => {
  const workspaceId = useActiveWorkspaceId();
  useUserStore((s) => s.useFetchWorkspaceUserPreference)();
  const favorites = useUserStore(favoritesOf(workspaceId), isEqual);
  const updatePreference = useUserStore((s) => s.updatePreference);
  const updateWorkspaceUserPreference = useUserStore((s) => s.updateWorkspaceUserPreference);

  const isFavorite = useCallback(
    (model: string, providers: readonly string[]) =>
      providers.some((provider) => favorites.includes(favoriteModelKey(provider, model))),
    [favorites],
  );

  const setFavorite = useCallback(
    async (model: string, providers: readonly string[], favorite: boolean) => {
      const keys = providers.map((provider) => favoriteModelKey(provider, model));
      // Read at click time: a second star can land before the first one re-renders this hook.
      const others = favoritesOf(workspaceId)(useUserStore.getState()).filter(
        (key) => !keys.includes(key),
      );
      const favoriteModels = favorite ? [...others, keys[0]] : others;

      await (workspaceId
        ? updateWorkspaceUserPreference({ favoriteModels })
        : updatePreference({ favoriteModels }));
    },
    [workspaceId, updatePreference, updateWorkspaceUserPreference],
  );

  return useMemo(
    () => ({ favorites, isFavorite, setFavorite }),
    [favorites, isFavorite, setFavorite],
  );
};
