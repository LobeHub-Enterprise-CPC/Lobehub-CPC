import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

import { parseFeatureFlag } from './utils/parser';

const env = createEnv({
  runtimeEnv: {
    FEATURE_FLAGS: process.env.FEATURE_FLAGS,
  },

  server: {
    FEATURE_FLAGS: z.string().optional(),
  },
});

/**
 * Only the flags explicitly configured via the FEATURE_FLAGS env var,
 * without schema defaults merged in.
 */
export const getExplicitServerFeatureFlags = () => parseFeatureFlag(env.FEATURE_FLAGS);

export * from './schema';
