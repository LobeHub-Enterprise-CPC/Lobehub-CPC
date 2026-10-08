import { businessAuthPlugins, getBusinessAuthOptions } from '@lobechat/business-auth';

import { authEnv } from '@/envs/auth';
import { defineConfig } from '@/libs/better-auth/define-config';

export const auth = defineConfig({
  ...(authEnv.AUTH_COOKIE_PREFIX && { cookiePrefix: authEnv.AUTH_COOKIE_PREFIX }),
  plugins: [...businessAuthPlugins],
});

/** Session reads use the base instance; only protocol requests load a provider snapshot. */
export const getAuthForRequest = async (request: Request) => {
  const overrides = await getBusinessAuthOptions(request);
  if (!overrides) return auth;
  return defineConfig({
    ...(authEnv.AUTH_COOKIE_PREFIX && { cookiePrefix: authEnv.AUTH_COOKIE_PREFIX }),
    plugins: [...businessAuthPlugins],
    overrides,
  });
};
