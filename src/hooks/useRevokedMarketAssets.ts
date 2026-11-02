import { useClientDataSWR } from '@/libs/swr';
import { agentSkillService } from '@/services/skill';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/slices/auth/selectors';

export const REVOKED_MARKET_ASSETS_SWR_KEY = 'agentSkills/listRevokedMarketAssets';

const EMPTY = new Set<string>();

/**
 * Identifiers of installed Market skills and plugins the enterprise has stopped making available
 * to the signed-in member. Runs already leave them out; the UI shows them as disabled.
 */
export const useRevokedMarketAssets = (): Set<string> => {
  const isLogin = useUserStore(authSelectors.isLogin);
  const { data } = useClientDataSWR<Set<string>>(
    isLogin ? [REVOKED_MARKET_ASSETS_SWR_KEY] : null,
    async () => new Set(await agentSkillService.listRevokedMarketAssets()),
    { dedupingInterval: 60_000, revalidateOnFocus: false },
  );
  return data ?? EMPTY;
};
