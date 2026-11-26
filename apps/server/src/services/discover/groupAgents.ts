import { type CategoryListQuery } from '@lobehub/market-sdk';

import type { DiscoverService } from './index';
import { withoutUnavailableModel } from './marketModelAvailability';
import { log } from './utils';

// ============================== Group Agent Market Methods ==============================

export const getGroupAgentCategories = async (
  service: DiscoverService,
  params?: CategoryListQuery,
) => {
  try {
    // TODO: SDK method not yet available, using fallback
    const response = await (service.market.agentGroups as any).getAgentGroupCategories?.(params);
    return response || { items: [] };
  } catch (error) {
    log('getGroupAgentCategories: error: %O', error);
    return { items: [] };
  }
};

export const getGroupAgentDetail = async (
  service: DiscoverService,
  params: {
    identifier: string;
    locale?: string;
    version?: string;
  },
) => {
  try {
    const response = await service.market.agentGroups.getAgentGroupDetail(params.identifier, {
      locale: params.locale,
      // Market reads `version` from the query string; the published SDK types it as a number.
      version: params.version ? Number(params.version) : undefined,
    });
    // Forking the group builds each member from its version config: drop retired models there.
    // Market returns `currentVersion` on members; the published SDK types omit it.
    if (!response?.memberAgents) return response;
    const memberAgents = await Promise.all(
      response.memberAgents.map(async (member) => {
        const { currentVersion } = member as { currentVersion?: { config?: Record<string, any> } };
        return currentVersion
          ? {
              ...member,
              currentVersion: {
                ...currentVersion,
                config: await withoutUnavailableModel(
                  currentVersion.config,
                  service.userInfo?.email,
                ),
              },
            }
          : member;
      }),
    );
    return { ...response, memberAgents };
  } catch (error) {
    log('getGroupAgentDetail: error: %O', error);
    throw error;
  }
};

export const getGroupAgentIdentifiers = async (service: DiscoverService) => {
  try {
    // TODO: SDK method not yet available, using fallback
    const response = await (service.market.agentGroups as any).getAgentGroupIdentifiers?.();
    return response || { identifiers: [] };
  } catch (error) {
    log('getGroupAgentIdentifiers: error: %O', error);
    return { identifiers: [] };
  }
};

export const getGroupAgentList = async (
  service: DiscoverService,
  params?: {
    category?: string;
    locale?: string;
    order?: 'asc' | 'desc';
    ownerId?: string;
    page?: number;
    pageSize?: number;
    q?: string;
    sort?: 'createdAt' | 'updatedAt' | 'name' | 'recommended';
  },
) => {
  try {
    const response = await service.market.agentGroups.getAgentGroupList({
      ...params,
      status: 'published' as any,
      visibility: 'public' as any,
    });
    return response;
  } catch (error) {
    log('getGroupAgentList: error: %O', error);
    return { currentPage: 1, items: [], totalCount: 0, totalPages: 1 };
  }
};
