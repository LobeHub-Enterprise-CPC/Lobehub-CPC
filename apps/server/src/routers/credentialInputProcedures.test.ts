// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { agentBotProviderRouter } from './lambda/agentBotProvider';
import { apiKeyRouter } from './lambda/apiKey';
import { comfyuiRouter } from './lambda/comfyui';
import { deviceRouter } from './lambda/device';
import { marketRouter } from './lambda/market';
import { mcpRouter } from './tools/mcp';

/**
 * tRPC queries are HTTP GETs whose input is serialized into the URL, so every
 * access / proxy / CDN log and the browser history records it. Procedures whose
 * input carries credentials (MCP auth / headers, API keys, client secrets, env
 * vars, key vaults, login tickets) must therefore be mutations (POST body).
 */
const CREDENTIAL_INPUT_PROCEDURES: Array<[string, { _def: { procedures: any } }, string]> = [
  ['tools.mcp.getStreamableMcpServerManifest', mcpRouter, 'getStreamableMcpServerManifest'],
  ['tools.mcp.listTools', mcpRouter, 'listTools'],
  ['tools.mcp.listResources', mcpRouter, 'listResources'],
  ['tools.mcp.listPrompts', mcpRouter, 'listPrompts'],
  ['lambda.apiKey.getApiKey', apiKeyRouter, 'getApiKey'],
  ['lambda.apiKey.validateApiKey', apiKeyRouter, 'validateApiKey'],
  ['lambda.comfyui.getAuthHeaders', comfyuiRouter, 'getAuthHeaders'],
  ['lambda.comfyui.getModels', comfyuiRouter, 'getModels'],
  ['lambda.device.getClaudeCodeQuota', deviceRouter, 'getClaudeCodeQuota'],
  ['lambda.device.listHeterogeneousAgentModels', deviceRouter, 'listHeterogeneousAgentModels'],
  ['lambda.market.registerM2MToken', marketRouter, 'registerM2MToken'],
  ['lambda.agentBotProvider.wechatPollQrStatus', agentBotProviderRouter, 'wechatPollQrStatus'],
];

describe('procedures whose input carries credentials', () => {
  it.each(CREDENTIAL_INPUT_PROCEDURES)(
    '%s is a mutation (POST body, not URL)',
    (_label, r, name) => {
      const procedure = r._def.procedures[name];

      expect(procedure).toBeDefined();
      expect(procedure._def.type).toBe('mutation');
    },
  );
});
