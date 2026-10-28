import { TRPCError } from '@trpc/server';

import { getServerFeatureFlagsStateFromRuntimeConfig } from '@/server/featureFlags';

export const assertImageGenerationEnabled = async (userId: string) => {
  const featureFlags = await getServerFeatureFlagsStateFromRuntimeConfig(userId);
  if (featureFlags.showAiImage !== true) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Image generation is not enabled for this account',
    });
  }
};
