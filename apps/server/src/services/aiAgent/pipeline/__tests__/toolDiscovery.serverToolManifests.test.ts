import { describe, expect, it, vi } from 'vitest';

import { buildChannelArtifactManifest } from '@/server/services/channel/artifactTool';

import { discoverTools } from '../toolDiscovery';

vi.mock('@/business/client/model-bank/loadModels', () => ({
  loadModels: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/database/models/aiModel', () => ({
  AiModelModel: class {
    findByIdAndProvider = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('@/database/models/aiProvider', () => ({
  AiProviderModel: class {
    findById = vi.fn().mockResolvedValue(undefined);
  },
}));

describe('discoverTools serverToolManifests', () => {
  it('injects host builtin manifests even when normal tool discovery produces no tools', async () => {
    const manifest = buildChannelArtifactManifest(['run-1'])!;
    const result = await discoverTools(
      {
        db: {} as never,
        userId: 'owner',
      } as never,
      {
        agentConfig: { chatConfig: {}, plugins: [] },
        appContext: undefined,
        canUseDevice: false,
        model: 'test-model',
        prompt: 'review',
        provider: 'test-provider',
        resolvedAgentId: 'agent',
        shareGate: undefined,
      } as never,
      {
        disableTools: true,
        disabledPluginIds: [],
        globalMemoryEnabled: false,
        hasMentionedAgents: false,
        isFixedDeviceTarget: false,
        loadHistoryMessages: vi.fn().mockResolvedValue([]),
        serverToolManifests: [manifest],
        throwIfExecutionAborted: vi.fn(),
      },
    );

    expect(result.toolManifestMap[manifest.identifier]).toBe(manifest);
    expect(result.toolsResult.enabledToolIds).toContain(manifest.identifier);
    expect(result.toolSourceMap[manifest.identifier]).toBe('builtin');
    expect(result.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ name: 'channel-artifact____read' }),
        type: 'function',
      }),
    ]);
  });
});
