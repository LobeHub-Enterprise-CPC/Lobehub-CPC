import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

/** Separate deployment-wide read-only identity; never falls back to DATABASE_URL. */
export const getTenantDiscoveryConfig = () =>
  createEnv({
    server: { ACCOUNT_LOOKUP_DATABASE_URL: z.string().url().optional() },
    runtimeEnv: { ACCOUNT_LOOKUP_DATABASE_URL: process.env.ACCOUNT_LOOKUP_DATABASE_URL },
  });
