import { getAgentTemplatesSWRKey } from '@lobechat/builtin-tool-web-onboarding/agentMarketplace';
import { ONBOARDING_AGENT_PICKER_ENABLED } from '@lobechat/business-const';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import { fetchOnboardingAgentTemplates } from '@/services/agentMarketplace';

const agentTemplatesSWRConfig = {
  dedupingInterval: 60_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
};

/**
 * Templates for the onboarding agent picker, from the hosted marketplace.
 * Deployments without the picker never fetch: the call can only fail there.
 */
export const useOnboardingAgentTemplates = (enabled = true) => {
  const { i18n } = useTranslation();
  const swrLocale = i18n.resolvedLanguage || i18n.language;

  return useSWR(
    enabled && ONBOARDING_AGENT_PICKER_ENABLED ? getAgentTemplatesSWRKey(swrLocale) : null,
    () => fetchOnboardingAgentTemplates(),
    agentTemplatesSWRConfig,
  );
};
