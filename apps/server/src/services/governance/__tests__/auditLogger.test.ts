import type { LobeChatDatabase } from '@lobechat/database';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getFlags: vi.fn(), insertLog: vi.fn() }));
vi.mock('@/server/featureFlags', () => ({
  getServerFeatureFlagsFromRuntimeConfig: mocks.getFlags,
}));
vi.mock('../logsRepository', () => ({ insertLog: mocks.insertLog }));
const { logCommandExecution } = await import('../auditLogger');
const ctx = {
  apiName: 'runCommand',
  executionTarget: 'local' as const,
  toolIdentifier: 'lobe-local-system',
  userId: 'user-1',
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.getFlags.mockResolvedValue({ command_governance: true });
});
afterEach(() => vi.restoreAllMocks());

it.each(['switch', 'write'])(
  'reports %s failure without failing the execution result',
  async (failure) => {
    if (failure === 'switch') mocks.getFlags.mockRejectedValue(new Error('unavailable'));
    else mocks.insertLog.mockRejectedValue(new Error('unavailable'));
    await expect(
      logCommandExecution(ctx, { blocked: false }, {} as LobeChatDatabase),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  },
);

it('does not write audit records when explicitly off', async () => {
  mocks.getFlags.mockResolvedValue({ command_governance: false });
  await logCommandExecution(ctx, { blocked: false }, {} as LobeChatDatabase);
  expect(mocks.insertLog).not.toHaveBeenCalled();
});
