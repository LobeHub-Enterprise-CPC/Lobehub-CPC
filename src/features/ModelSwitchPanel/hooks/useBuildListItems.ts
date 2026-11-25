import { modelMappings } from '@lobehub/icons';
import dayjs from 'dayjs';
import { useMemo } from 'react';

import { type EnabledProviderWithModels } from '@/types/aiProvider';
import { isNewReleaseDate } from '@/utils/time';

import { type GroupMode, type ListItem, type ModelWithProviders } from '../types';
import { favoriteModelKey } from '../utils';

/**
 * Shares the exact rule behind `NewModelBadge`. Every renderer of this list must keep the badge
 * on — otherwise pinned models jump ahead with no visible explanation.
 */
const isNewModel = (releasedAt?: string): boolean => !!releasedAt && isNewReleaseDate(releasedAt);

/**
 * Caps how many new models jump ahead of the catalog order. A busy launch week can badge many
 * models at once; pinning all of them would push every established model out of the first screen.
 * New models beyond the cap keep their badge but stay in their catalog position.
 */
export const MAX_PINNED_NEW_MODELS = 4;

/**
 * Resolves the vendor series a model belongs to with the same keyword table `ModelIcon` uses, so
 * "same series" always means "same row icon" to the user. Models without a matching icon form a
 * series of their own.
 */
const getModelSeries = (modelId: string): unknown => {
  const id = modelId.toLowerCase();
  const mapping = modelMappings.find((item) =>
    item.keywords.some((keyword) => new RegExp(keyword, 'i').test(id)),
  );

  return mapping?.Icon ?? modelId;
};

/**
 * Pins at most {@link MAX_PINNED_NEW_MODELS} new models to the top and keeps the remaining items
 * in catalog order.
 *
 * The pinned models are chosen newest-first, so a busy week keeps today's launch over one from
 * days earlier. They are then grouped by vendor series: series are ordered by their newest model,
 * and models within a series keep catalog order to match the list below. Ordering purely by
 * release date would scatter one vendor's launches across the pinned zone (e.g. Claude Haiku 5.5
 * first and Claude Sonnet 5.5 fourth); ordering purely by `displayOrder` would let whichever
 * vendor sits earliest in the catalog outrank a newer launch.
 *
 * Items flagged by `isLast` sink below everything else and are never pinned.
 */
const sortWithPinnedNewModels = <T>(
  items: T[],
  getModel: (item: T) => { id: string; releasedAt?: string },
  isLast?: (item: T) => boolean,
): T[] => {
  const releasedAtOf = (item: T) => dayjs(getModel(item).releasedAt).valueOf();

  const pinnedSet = new Set(
    items
      .filter((item) => !isLast?.(item) && isNewModel(getModel(item).releasedAt))
      .toSorted((a, b) => releasedAtOf(b) - releasedAtOf(a))
      .slice(0, MAX_PINNED_NEW_MODELS),
  );

  const seriesNewest = new Map<unknown, number>();
  for (const item of pinnedSet) {
    const series = getModelSeries(getModel(item).id);
    seriesNewest.set(series, Math.max(seriesNewest.get(series) ?? 0, releasedAtOf(item)));
  }
  // Same-newness series fall back to catalog order via stable sort.
  const pinned = items
    .filter((item) => pinnedSet.has(item))
    .toSorted(
      (a, b) =>
        seriesNewest.get(getModelSeries(getModel(b).id))! -
        seriesNewest.get(getModelSeries(getModel(a).id))!,
    );

  const rest = items.filter((item) => !pinnedSet.has(item));

  return [
    ...pinned,
    ...(isLast ? rest.toSorted((a, b) => Number(isLast(a)) - Number(isLast(b))) : rest),
  ];
};

const NO_FAVORITES: readonly string[] = [];

/**
 * `favorites` are the starred models (`provider/model`, in the order they were starred). They move
 * to a section of their own at the top and leave the list below, so no model shows twice; a starred
 * model that is not enabled stays out of the list like any other.
 */
export const buildListItems = (
  enabledList: EnabledProviderWithModels[],
  groupMode: GroupMode,
  searchKeyword: string = '',
  sortModelLast?: (modelId: string, providerId: string) => boolean,
  favorites: readonly string[] = NO_FAVORITES,
): ListItem[] => {
  if (enabledList.length === 0) {
    return [{ type: 'no-provider' }] as ListItem[];
  }

  const matchesSearch = (text: string): boolean => {
    if (!searchKeyword.trim()) return true;
    const keyword = searchKeyword.toLowerCase().trim();
    return text.toLowerCase().includes(keyword);
  };

  const favoriteRanks = new Map(favorites.map((key, index) => [key, index]));
  /** Position of a starred row, or -1. A row offered by several providers takes its first star. */
  const favoriteRank = (modelId: string, providerIds: string[]): number => {
    const ranks = providerIds
      .map((providerId) => favoriteRanks.get(favoriteModelKey(providerId, modelId)))
      .filter((rank) => rank !== undefined);
    return ranks.length > 0 ? Math.min(...ranks) : -1;
  };

  // lobehub first, then others
  const sortedProviders = [...enabledList].sort((a, b) => {
    const aIsLobehub = a.id === 'lobehub';
    const bIsLobehub = b.id === 'lobehub';
    if (aIsLobehub && !bIsLobehub) return -1;
    if (!aIsLobehub && bIsLobehub) return 1;
    return 0;
  });

  if (groupMode === 'byModel') {
    const modelMap = new Map<string, ModelWithProviders>();

    for (const providerItem of sortedProviders) {
      for (const modelItem of providerItem.children) {
        const displayName = modelItem.displayName || modelItem.id;

        if (!matchesSearch(displayName) && !matchesSearch(providerItem.name)) {
          continue;
        }

        if (!modelMap.has(displayName)) {
          modelMap.set(displayName, {
            displayName,
            model: modelItem,
            providers: [],
          });
        }

        const entry = modelMap.get(displayName)!;
        entry.providers.push({
          id: providerItem.id,
          logo: providerItem.logo,
          name: providerItem.name,
          source: providerItem.source,
        });
      }
    }

    // lobehub first
    const modelArray = Array.from(modelMap.values());
    for (const model of modelArray) {
      model.providers.sort((a, b) => {
        const aIsLobehub = a.id === 'lobehub';
        const bIsLobehub = b.id === 'lobehub';
        if (aIsLobehub && !bIsLobehub) return -1;
        if (!aIsLobehub && bIsLobehub) return 1;
        return 0;
      });
    }

    const rankOf = (item: ModelWithProviders) =>
      favoriteRank(
        item.model.id,
        item.providers.map((provider) => provider.id),
      );
    const favoriteModels = modelArray
      .filter((item) => rankOf(item) >= 0)
      .toSorted((a, b) => rankOf(a) - rankOf(b));

    const sortedModels = sortWithPinnedNewModels(
      modelArray.filter((item) => rankOf(item) < 0),
      (item) => item.model,
      sortModelLast &&
        ((item) => item.providers.every((provider) => sortModelLast(item.model.id, provider.id))),
    );

    const toItem = (data: ModelWithProviders): ListItem => ({
      data,
      type: data.providers.length === 1 ? 'model-item-single' : 'model-item-multiple',
    });
    const otherItems = sortedModels.map(toItem);
    if (favoriteModels.length === 0) return otherItems;

    return [
      { section: 'favorites', type: 'section-header' },
      ...favoriteModels.map(toItem),
      ...(otherItems.length > 0
        ? [{ section: 'others', type: 'section-header' } satisfies ListItem]
        : []),
      ...otherItems,
    ];
  } else {
    const items: ListItem[] = [];
    const favoriteItems: { item: ListItem; rank: number }[] = [];

    for (const providerItem of sortedProviders) {
      const matchedModels = providerItem.children.filter(
        (modelItem) =>
          matchesSearch(modelItem.displayName || modelItem.id) || matchesSearch(providerItem.name),
      );
      const filteredModels = matchedModels.filter((modelItem) => {
        const rank = favoriteRank(modelItem.id, [providerItem.id]);
        if (rank < 0) return true;

        favoriteItems.push({
          item: { model: modelItem, provider: providerItem, type: 'provider-model-item' },
          rank,
        });
        return false;
      });
      // Every match is starred, so the group has nothing left to list here.
      if (matchedModels.length > 0 && filteredModels.length === 0) continue;

      const sortedModels = sortWithPinnedNewModels(
        filteredModels,
        (item) => item,
        sortModelLast && ((item) => sortModelLast(item.id, providerItem.id)),
      );

      if (sortedModels.length > 0 || !searchKeyword.trim()) {
        items.push({ provider: providerItem, type: 'group-header' });

        if (sortedModels.length === 0) {
          items.push({ provider: providerItem, type: 'empty-model' });
        } else {
          for (const modelItem of sortedModels) {
            items.push({
              model: modelItem,
              provider: providerItem,
              type: 'provider-model-item',
            });
          }
        }
      }
    }

    if (favoriteItems.length === 0) return items;

    return [
      { section: 'favorites', type: 'section-header' },
      ...favoriteItems.toSorted((a, b) => a.rank - b.rank).map(({ item }) => item),
      ...items,
    ];
  }
};

export const useBuildListItems = (
  enabledList: EnabledProviderWithModels[],
  groupMode: GroupMode,
  searchKeyword: string = '',
  sortModelLast?: (modelId: string, providerId: string) => boolean,
  favorites?: readonly string[],
): ListItem[] =>
  useMemo(
    () => buildListItems(enabledList, groupMode, searchKeyword, sortModelLast, favorites),
    [enabledList, groupMode, searchKeyword, sortModelLast, favorites],
  );
