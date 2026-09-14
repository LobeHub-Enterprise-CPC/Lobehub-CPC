// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import {
  beginChannelServerDefaultOperation,
  settleChannelServerDefaultOperation,
} from './serverDefault';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  models: vi.fn(),
  record: vi.fn(),
  resolve: vi.fn(),
  runtime: vi.fn(),
  settle: vi.fn(),
  sign: vi.fn(),
}));
vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: class {
    findById = mocks.find;
    recordStart = mocks.record;
    settleRunning = mocks.settle;
  },
}));
vi.mock('@/server/modules/ModelRuntime', () => ({
  getServerDefaultHeterogeneousModels: mocks.models,
  initModelRuntimeFromServerConfig: mocks.runtime,
  resolveServerDefaultHeterogeneousModel: mocks.resolve,
  SERVER_DEFAULT_HETEROGENEOUS_AGENT_TYPES: ['codex', 'grok-build'],
}));
vi.mock('@/libs/trpc/utils/internalJwt', () => ({ signHeteroOperationJWT: mocks.sign }));

const db = {} as LobeChatDatabase;
const provider = {
  type: 'codex' as const,
  authMode: 'api' as const,
  apiConfig: { source: 'server-default' as const, model: 'requested' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENABLE_SERVER_DEFAULT_HETEROGENEOUS_AGENT', '1');
  mocks.models.mockResolvedValue({ codex: [{ model: 'selected' }] });
  mocks.resolve.mockResolvedValue({ model: 'selected', provider: 'server-provider' });
  mocks.runtime.mockResolvedValue({});
  mocks.sign.mockResolvedValue('scoped-token');
  mocks.find.mockResolvedValue({
    agentId: 'agent',
    metadata: { agentType: 'codex', channelServerDefault: true },
    model: 'selected',
    provider: 'server-provider',
    status: 'running',
    topicId: null,
    userId: 'owner',
    workspaceId: null,
  });
});

describe('Channel server-default operation', () => {
  it('records a topic-less scoped operation before returning only model and token', async () => {
    await expect(
      beginChannelServerDefaultOperation({
        agentId: 'agent',
        db,
        ownerId: 'owner',
        provider,
        runId: 'run',
        runtime: 'codex',
      }),
    ).resolves.toEqual({ model: 'lobehub-default', token: 'scoped-token' });
    expect(mocks.resolve).toHaveBeenCalledWith('codex', 'requested');
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent',
        operationId: 'run',
        model: 'selected',
        provider: 'server-provider',
        metadata: expect.objectContaining({ channelServerDefault: true }),
      }),
    );
    expect(mocks.record.mock.calls[0][0]).not.toHaveProperty('topicId');
    expect(mocks.sign).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'run', userId: 'owner', workspaceId: undefined }),
    );
  });

  it('does nothing for subscription auth and rejects a conflicting operation selection', async () => {
    await expect(
      beginChannelServerDefaultOperation({
        agentId: 'agent',
        db,
        ownerId: 'owner',
        provider: { type: 'codex' },
        runId: 'run',
        runtime: 'codex',
      }),
    ).resolves.toBeUndefined();
    expect(mocks.record).not.toHaveBeenCalled();
    mocks.find.mockResolvedValueOnce({ ...(await mocks.find()), model: 'other' });
    await expect(
      beginChannelServerDefaultOperation({
        agentId: 'agent',
        db,
        ownerId: 'owner',
        provider,
        runId: 'run',
        runtime: 'codex',
      }),
    ).rejects.toThrow('already in use');
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it('settles only marked topic-less operations', async () => {
    mocks.settle.mockResolvedValue(true);
    await settleChannelServerDefaultOperation({
      db,
      ownerId: 'owner',
      runId: 'run',
      status: 'interrupted',
    });
    expect(mocks.settle).toHaveBeenCalledWith('run', 'interrupted');
    mocks.find.mockResolvedValueOnce({ metadata: {}, status: 'running', topicId: null });
    await settleChannelServerDefaultOperation({
      db,
      ownerId: 'owner',
      runId: 'other',
      status: 'done',
    });
    expect(mocks.settle).toHaveBeenCalledTimes(1);
  });

  it('preserves an existing Channel terminal status during reconciliation', async () => {
    for (const status of ['done', 'error'] as const) {
      mocks.find.mockResolvedValueOnce({
        metadata: { channelServerDefault: true },
        status,
        topicId: null,
        userId: 'owner',
        workspaceId: null,
      });
      await settleChannelServerDefaultOperation({
        db,
        ownerId: 'owner',
        runId: `run-${status}`,
        status: 'interrupted',
      });
    }
    expect(mocks.settle).not.toHaveBeenCalled();
  });
});
