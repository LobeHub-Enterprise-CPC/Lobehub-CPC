import type { NetworkProxySettings } from '@lobechat/electron-client-ipc';
import { stripInheritedRunIdentity } from '@lobechat/heterogeneous-agents/protocol';
import { getHeterogeneousAgentPresetEnv } from '@lobechat/heterogeneous-agents/spawn';

import { withEmbeddedCliEnv } from '@/modules/cliEmbedding';
import { buildProxyEnv } from '@/modules/networkProxy/envBuilder';

/**
 * Shell credentials must not replace a CLI's subscription login. An ancestor agent run's
 * identity (a Desktop launched from an agent shell carries its JWT file, which the CLI
 * prefers over any token) is stripped for the same reason. Explicit Agent env wins.
 */
export const buildInheritedSpawnEnv = (
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const env = stripInheritedRunIdentity(sourceEnv);
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
  const inheritedEnv = buildInheritedSpawnEnv();
  // When preflight resolved the CLI via the login-shell PATH, spawn with that PATH (a
  // superset of the inherited one) so a `#!/usr/bin/env node` shim finds its interpreter.
  if (options.searchPath) inheritedEnv.PATH = options.searchPath;
  const env: NodeJS.ProcessEnv = {
    // The bundled CLI wins over a stale global `lh`; presets sit under the agent's
    // own env so an explicit per-agent setting still wins.
    ...withEmbeddedCliEnv(inheritedEnv),
    ...buildProxyEnv(options.proxy),
    ...getHeterogeneousAgentPresetEnv(options.agentType),
    ...options.env,
  };
  if (options.agentType === 'grok-build' && options.providerBound) {
    delete env.GROK_CODE_XAI_API_KEY;
    delete env.XAI_API_KEY;
  }
  return env;
}
