import type { NetworkProxySettings } from '@lobechat/electron-client-ipc';

import { buildProxyEnv } from '@/modules/networkProxy/envBuilder';

/** Shell credentials must not replace a CLI's subscription login. Explicit Agent env wins. */
export const buildInheritedSpawnEnv = (
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const env = { ...sourceEnv };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return env;
};

export function buildDesktopSpawnEnv(options: {
  agentType: string;
  env?: NodeJS.ProcessEnv;
  providerBound?: boolean;
  proxy?: NetworkProxySettings;
  searchPath?: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildInheritedSpawnEnv(),
    ...(options.searchPath ? { PATH: options.searchPath } : {}),
    ...buildProxyEnv(options.proxy),
    ...(options.agentType === 'codebuddy' ? { CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1' } : {}),
    ...options.env,
  };
  if (options.agentType === 'grok-build' && options.providerBound) {
    delete env.GROK_CODE_XAI_API_KEY;
    delete env.XAI_API_KEY;
  }
  return env;
}
