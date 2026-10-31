import { describe, expect, it, vi } from 'vitest';

import { StepOwnershipLostError } from '../AgentRuntimeService/executionErrors';
import { persistCompletion } from './persistence';

describe('completion write ownership', () => {
  it.each([false, true])(
    'propagates ownership loss during child usage (strict=%s)',
    async (strict) => {
      const lost = new StepOwnershipLostError('op-owned', 1);
      let owned = true;
      const recordCompletion = vi.fn().mockResolvedValue(true);
      const deps = {
        agentOperationModel: {
          recordCompletion,
          sumChildUsage: vi.fn(async () => {
            owned = false;
          }),
        },
      };
      await expect(
        persistCompletion(
          deps as any,
          'op-owned',
          { status: 'done' },
          'done',
          undefined,
          strict,
          async () => {
            if (!owned) throw lost;
          },
        ),
      ).rejects.toBe(lost);
      expect(recordCompletion).not.toHaveBeenCalled();
    },
  );
});
