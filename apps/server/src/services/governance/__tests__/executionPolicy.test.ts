import type { LobeChatDatabase } from '@lobechat/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getFlags: vi.fn(), getPolicy: vi.fn() }));
vi.mock('@/server/featureFlags', () => ({
  getServerFeatureFlagsFromRuntimeConfig: mocks.getFlags,
}));
vi.mock('../executionPolicyRepository', () => ({ getPolicyForUser: mocks.getPolicy }));

const { getUserExecutionPolicy } = await import('../executionPolicy');
const { checkPath } = await import('../pathPolicy');
const { GovernanceUnavailableError } = await import('../policyGate');
const db = {} as LobeChatDatabase;
const ctx = {
  apiName: 'readFile',
  executionTarget: 'local' as const,
  path: '/home/alice/.ssh/key',
  toolIdentifier: 'lobe-local-system',
  userId: 'user-1',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.getFlags.mockResolvedValue({ command_governance: true });
});
afterEach(() => vi.restoreAllMocks());

describe('execution policy enforcement', () => {
  it.each(['switch', 'policy'])(
    'rejects policy resolution and file access on %s failure',
    async (failure) => {
      if (failure === 'switch') mocks.getFlags.mockRejectedValue(new Error('unavailable'));
      else mocks.getPolicy.mockRejectedValue(new Error('unavailable'));

      await expect(getUserExecutionPolicy('user-1', db)).rejects.toBeInstanceOf(
        GovernanceUnavailableError,
      );
      await expect(checkPath(ctx, db)).rejects.toBeInstanceOf(GovernanceUnavailableError);
    },
  );

  it('returns unrestricted only when the switch is explicitly off without loading policy', async () => {
    mocks.getFlags.mockResolvedValue({ command_governance: false });
    expect(await getUserExecutionPolicy('user-1', db)).toBeNull();
    expect(await checkPath(ctx, db)).toEqual({ allowed: true });
    expect(mocks.getPolicy).not.toHaveBeenCalled();
  });

  it.each([null, { enabled: false }])(
    'allows an absent or disabled policy after a successful lookup',
    async (policy) => {
      mocks.getPolicy.mockResolvedValue(policy);
      expect(await getUserExecutionPolicy('user-1', db)).toBeNull();
    },
  );

  it('enforces a loaded policy and permits an unrelated path', async () => {
    mocks.getPolicy.mockResolvedValue({ enabled: true, deniedReadRoots: ['~/.ssh'] });
    expect(await checkPath(ctx, db)).toEqual({ allowed: false, matchedField: 'deniedReadRoots' });
    expect(await checkPath({ ...ctx, path: '/tmp/notes' }, db)).toEqual({ allowed: true });
  });
});
