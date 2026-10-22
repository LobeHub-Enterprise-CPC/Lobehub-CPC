'use client';

import { confirmModal, toast } from '@lobehub/ui';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useMarketAuth } from '@/layout/AuthProvider/MarketAuth';
import { marketApiService } from '@/services/marketApi';
import { serverConfigSelectors, useServerConfigStore } from '@/store/serverConfig';

export type AgentStatusAction = 'deprecate';
export type EntityType = 'agent' | 'group';

interface UseUserDetailOptions {
  onMutate?: () => void;
}

export const useUserDetail = ({ onMutate }: UseUserDetailOptions = {}) => {
  const { t } = useTranslation('setting');

  const { session } = useMarketAuth();
  const enableMarketTrustedClient = useServerConfigStore(
    serverConfigSelectors.enableMarketTrustedClient,
  );

  const handleStatusChange = useCallback(
    async (identifier: string, action: AgentStatusAction, type: EntityType = 'agent') => {
      if (!enableMarketTrustedClient && !session?.accessToken) {
        toast.error(t('myAgents.errors.notAuthenticated'));
        return;
      }

      const loadingText = t(`myAgents.actions.${action}Loading` as any);
      const successText = t(`myAgents.actions.${action}Success` as any);
      const errorText = t(`myAgents.actions.${action}Error` as any);

      async function executeStatusChange(identifier: string, type: EntityType) {
        const pendingToast = toast.loading(loadingText);
        try {
          if (type === 'group') {
            await marketApiService.deprecateAgentGroup(identifier);
          } else {
            await marketApiService.deprecateAgent(identifier);
          }

          pendingToast.close();
          toast.success(successText);
          onMutate?.();
        } catch (error) {
          console.error(`[useUserDetail] ${action} ${type} error:`, error);
          pendingToast.close();
          toast.error(`${errorText}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          // The refusal may be Market saying what the user may do with this item
          // has changed (403), or that it is gone (404): read the item again so
          // the buttons follow instead of offering the same action a second time.
          onMutate?.();
        }
      }

      confirmModal({
        cancelText: t('myAgents.actions.cancel'),
        content: t('myAgents.actions.deprecateConfirmContent'),
        okButtonProps: { danger: true },
        okText: t('myAgents.actions.confirmDeprecate'),
        onOk: async () => {
          await executeStatusChange(identifier, type);
        },
        title: t('myAgents.actions.deprecateConfirmTitle'),
      });
    },
    [enableMarketTrustedClient, session?.accessToken, t, onMutate],
  );

  return {
    handleStatusChange,
  };
};
