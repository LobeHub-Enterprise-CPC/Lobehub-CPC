import { describe, expect, it, vi } from 'vitest';

import { SubAgentBridgeError } from '../subAgentBridgeError';
import { startOperation } from './startOperation';

describe('sub-agent bridge startup errors', () => {
  it.each(['PRECONDITION_FAILED', 'SERVICE_UNAVAILABLE'] as const)(
    'preserves %s for the caller',
    async (code) => {
      const error = new SubAgentBridgeError(code);
      const update = vi.fn();
      const deps = {
        agentRuntimeService: { createOperation: vi.fn().mockRejectedValue(error) },
        messageModel: { update },
      } as unknown as Parameters<typeof startOperation>[0];
      const ctx = { assistantMessageId: 'message' } as Parameters<typeof startOperation>[1];
      const input = {
        approvalClaim: {},
        discovery: { modelMediaCapabilities: {}, toolsResult: {} },
        prep: { deviceSystemInfo: {} },
      } as Parameters<typeof startOperation>[2];

      await expect(startOperation(deps, ctx, input)).rejects.toBe(error);
      expect(update).not.toHaveBeenCalled();
    },
  );
});
