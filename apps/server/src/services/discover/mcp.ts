import { type DiscoverMcpDetail, type McpListResponse, type McpQueryParams } from '@lobechat/types';
import { CacheRevalidate, CacheTag, McpCategory, McpSorts } from '@lobechat/types';
import { type CategoryItem, type CategoryListQuery } from '@lobehub/market-sdk';

import { normalizeLocale } from '@/locales/resources';
import { marketFetchCache } from '@/server/services/market/fetchCache';

import type { DiscoverService } from './index';
import { log } from './utils';

// ============================== MCP Market ==============================

export const getMcpCategories = async (
  service: DiscoverService,
  params: CategoryListQuery = {},
): Promise<CategoryItem[]> => {
  log('getMcpCategories: params=%O', params);
  const { locale } = params;
  const normalizedLocale = normalizeLocale(locale);
  const result = await service.market.plugins.getCategories(
    {
      ...params,
      locale: normalizedLocale,
    },
    marketFetchCache({
      revalidate: 3600,
    }),
  );
  log('getMcpCategories: returning %d categories', result.length);
  return result;
};

export const getMcpDetail = async (
  service: DiscoverService,
  params: {
    identifier: string;
    locale?: string;
    version?: string;
  },
): Promise<DiscoverMcpDetail> => {
  log('getMcpDetail: params=%O', params);
  const { locale } = params;
  const normalizedLocale = normalizeLocale(locale);
  const mcp = await service.market.plugins.getPluginDetail(
    { ...params, locale: normalizedLocale },
    marketFetchCache({
      revalidate: 3600,
    }),
  );

  // Fetch related MCPs
  const list = await service.getMcpList({
    category: mcp.category,
    locale,
    page: 1,
    pageSize: 7,
  });

  const result = {
    ...mcp,
    related: list.items.filter((item) => item.identifier !== mcp.identifier).slice(0, 6),
  };
  log('getMcpDetail: returning mcp with %d related items', result.related.length);
  return result;
};

export const getMcpList = async (
  service: DiscoverService,
  params: McpQueryParams = {},
): Promise<McpListResponse> => {
  log('getMcpList: params=%O', params);
  const { category, locale, sort } = params;
  const normalizedLocale = normalizeLocale(locale);
  const shouldOmitCategory = [McpCategory.All, McpCategory.Discover].includes(
    category as McpCategory,
  );

  const result = await service.market.plugins.getPluginList(
    {
      ...params,
      category: shouldOmitCategory ? undefined : category,
      locale: normalizedLocale,
      sort: shouldOmitCategory ? McpSorts.Recommended : sort,
    },
    marketFetchCache({
      revalidate: CacheRevalidate.List,
      tags: [CacheTag.Discover, CacheTag.MCP],
    }),
  );
  log('getMcpList: returning %d items on page %d', result.items.length, result.currentPage);
  return result;
};

export const getMcpManifest = async (
  service: DiscoverService,
  params: { identifier: string; locale?: string; version?: string },
) => {
  log('getMcpManifest: params=%O', params);
  const { locale } = params;
  const normalizedLocale = normalizeLocale(locale);
  const result = await service.market.plugins.getPluginManifest(
    {
      ...params,
      locale: normalizedLocale,
    },
    marketFetchCache({
      revalidate: CacheRevalidate.List,
      tags: [CacheTag.Discover, CacheTag.MCP],
    }),
  );
  log('getMcpManifest: returning manifest for %s', params.identifier);
  return result;
};
