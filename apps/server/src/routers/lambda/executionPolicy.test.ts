// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executionPolicyRouter } from './executionPolicy';

const mocks = vi.hoisted(() => ({
  GovernanceUnavailableError: class GovernanceUnavailableError extends Error {},
  getUserExecutionPolicy: vi.fn(),
  logCommandExecution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => ({})) }));

vi.mock('@/server/services/governance', () => ({
  GOVERNANCE_UNAVAILABLE_MESSAGE: 'governance unavailable',
  GovernanceUnavailableError: mocks.GovernanceUnavailableError,
  getUserExecutionPolicy: mocks.getUserExecutionPolicy,
  logCommandExecution: mocks.logCommandExecution,
}));

const caller = () => executionPolicyRouter.createCaller({ userId: 'user-1' } as any);

describe('executionPolicyRouter', () => {
  beforeEach(() => {
    mocks.getUserExecutionPolicy.mockReset();
    mocks.logCommandExecution.mockReset().mockResolvedValue(undefined);
  });

  describe('get', () => {
    it('resolves the policy for the calling user', async () => {
      mocks.getUserExecutionPolicy.mockResolvedValueOnce({ commandMode: 'sandbox' });

      const result = await caller().get();

      expect(result).toEqual({ commandMode: 'sandbox' });
      expect(mocks.getUserExecutionPolicy).toHaveBeenCalledWith('user-1', expect.anything());
    });

    it('resolves null when the user has no policy configured', async () => {
      mocks.getUserExecutionPolicy.mockResolvedValueOnce(null);

      const result = await caller().get();

      expect(result).toBeNull();
    });
  });

  describe('get when governance cannot be loaded', () => {
    it('answers 503 instead of an unrestricted null policy', async () => {
      mocks.getUserExecutionPolicy.mockRejectedValueOnce(new mocks.GovernanceUnavailableError());

      await expect(caller().get()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    });

    it('does not mask other failures', async () => {
      mocks.getUserExecutionPolicy.mockRejectedValueOnce(new Error('boom'));

      await expect(caller().get()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    });
  });

  describe('logFileAccess', () => {
    it('persists a blocked-file-access row scoped to the calling user and local target', async () => {
      await caller().logFileAccess({
        apiName: 'writeFile',
        matchedField: 'deniedWriteRoots',
        path: '/Users/alice/.ssh/config',
      });

      expect(mocks.logCommandExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          apiName: 'writeFile',
          executionTarget: 'local',
          path: '/Users/alice/.ssh/config',
          toolIdentifier: 'lobe-local-system',
          userId: 'user-1',
        }),
        { blocked: true, matchedField: 'deniedWriteRoots' },
        expect.anything(),
      );
    });

    it('rejects an invalid matchedField before ever calling logCommandExecution', async () => {
      await expect(
        caller().logFileAccess({
          apiName: 'writeFile',
          matchedField: 'somethingElse' as any,
          path: '/Users/alice/.ssh/config',
        }),
      ).rejects.toThrow();

      expect(mocks.logCommandExecution).not.toHaveBeenCalled();
    });

    it('rejects an empty path', async () => {
      await expect(
        caller().logFileAccess({
          apiName: 'writeFile',
          matchedField: 'deniedWriteRoots',
          path: '',
        }),
      ).rejects.toThrow();
    });
  });
});
