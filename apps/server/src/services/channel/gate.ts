import { evaluateFeatureFlag } from '@/config/featureFlags';
import { getServerFeatureFlagsFromRuntimeConfig } from '@/server/featureFlags';

import { getChannelGatewayUrl } from './gateway';

/**
 * Channels are enabled for a user when the deployment configured a valid
 * gateway and the `channel` feature flag is on for that user.
 */
export const isChannelEnabled = async (userId: string): Promise<boolean> => {
  if (!getChannelGatewayUrl()) return false;

  const flags = await getServerFeatureFlagsFromRuntimeConfig(userId);

  return evaluateFeatureFlag(flags.channel, userId) === true;
};
