import { describe, expect, it, vi } from 'vitest';

import { completeSubAgentBridge } from './subAgentBridge';

const mocks = vi.hoisted(() => ({
  delivered: vi.fn(),
  claim: vi.fn().mockResolvedValue(true),
  enabled: true,
  allowed: true,
}));
vi.mock('@/server/modules/Hatchet/config', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isHatchetDeliveryEnabled: () => mocks.enabled,
}));
vi.mock('@/server/services/gatewayAuthorization/parentExecution', () => ({
  gatewayParentMayResume: () => mocks.allowed,
}));
vi.mock('./validateSubAgentBridge', () => ({
  validateSubAgentBridge: async () => ({ allowed: true }),
}));
vi.mock('@/database/models/agentSubAgentBridge', () => ({
  AgentSubAgentBridgeModel: class {
    claim = mocks.claim;
    release = vi.fn().mockResolvedValue(true);
    markDelivered = mocks.delivered;
  },
}));

const params = {
  operationId: 'child',
  parentOperationId: 'parent',
  reason: 'done',
  threadId: 'thread',
  toolMessageId: 'tool',
};

describe('bridge delivery confirmation', () => {
  it('uses the reconciliation timeout reason even if the child state contains an error', async () => {
    const control = vi
      .fn()
      .mockImplementation(async ({ result }: { result: unknown }) => ({ result }));
    const deps = {
      serverDB: {},
      userId: 'user',
      coordinator: {
        loadAgentState: vi.fn().mockResolvedValue({ error: { message: 'child error' } }),
      },
      isCallSubAgentToolMessage: vi.fn().mockResolvedValue(false),
      controlCompletedToolResult: control,
      messageModel: { updateToolMessage: vi.fn().mockResolvedValue({ success: true }) },
      tryResumeParentFromAsyncTool: vi.fn().mockResolvedValue(false),
    } as unknown as Parameters<typeof completeSubAgentBridge>[0];
    await completeSubAgentBridge(deps, {
      ...params,
      reason: 'error',
      errorMessage: 'Recovery window expired',
      reconcileLeaseOwner: 'worker',
    });
    expect(control).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          content: expect.stringContaining('Recovery window expired'),
          success: false,
        }),
      }),
    );
  });
  it('makes a normal callback retry when a reconciler holds the lease', async () => {
    mocks.claim.mockResolvedValueOnce(false);
    const deps = {
      serverDB: {},
      userId: 'user',
      controlCompletedToolResult: vi.fn(),
    } as unknown as Parameters<typeof completeSubAgentBridge>[0];
    await expect(completeSubAgentBridge(deps, params)).rejects.toThrow('leased');
    expect(deps.controlCompletedToolResult).not.toHaveBeenCalled();
  });
  it('marks the matching binding after backfill and barrier processing', async () => {
    const order: string[] = [];
    mocks.delivered.mockImplementation(async () => {
      order.push('delivered');
    });
    const deps = {
      serverDB: {},
      userId: 'user',
      coordinator: {
        loadAgentState: vi
          .fn()
          .mockResolvedValue({ messages: [{ role: 'assistant', content: 'answer' }] }),
      },
      isCallSubAgentToolMessage: vi.fn().mockResolvedValue(false),
      controlCompletedToolResult: vi.fn().mockResolvedValue({ result: { content: 'answer' } }),
      messageModel: { updateToolMessage: vi.fn().mockResolvedValue({ success: true }) },
      tryResumeParentFromAsyncTool: vi.fn(async () => {
        order.push('barrier');
        return false;
      }),
    } as unknown as Parameters<typeof completeSubAgentBridge>[0];
    await completeSubAgentBridge(deps, params);
    expect(order).toEqual(['barrier', 'delivered']);
    expect(mocks.delivered).toHaveBeenCalledWith('child', {
      completionReason: 'done',
      parentOperationId: 'parent',
      threadId: 'thread',
      toolMessageId: 'tool',
      userId: 'user',
      leaseOwner: expect.any(String),
    });
    mocks.delivered.mockClear();
    mocks.enabled = false;
    await completeSubAgentBridge(deps, params);
    expect(mocks.delivered).not.toHaveBeenCalled();
    mocks.enabled = true;
    vi.mocked(deps.tryResumeParentFromAsyncTool).mockRejectedValueOnce(new Error('barrier failed'));
    await expect(completeSubAgentBridge(deps, params)).rejects.toThrow('barrier failed');
    expect(mocks.delivered).not.toHaveBeenCalled();
  });
});
