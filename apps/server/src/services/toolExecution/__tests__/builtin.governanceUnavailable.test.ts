import type { LobeChatDatabase } from '@lobechat/database';
import type { ChatToolPayload } from '@lobechat/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkCommand: vi.fn(),
  checkPath: vi.fn(),
  run: vi.fn(),
  audit: vi.fn(),
  GovernanceUnavailableError: class GovernanceUnavailableError extends Error {},
}));
vi.mock('../serverRuntimes', () => ({
  hasServerRuntime: () => true,
  getServerRuntime: async () => ({ writeFile: mocks.run, runCommand: mocks.run }),
}));
vi.mock('@lobechat/builtin-tools', () => ({ builtinTools: [] }));
vi.mock('@/server/services/aiAgent/shareGate', () => ({
  isShareBlockedBuiltinDispatch: () => false,
}));
vi.mock('@/server/services/composio', () => ({ ComposioService: vi.fn() }));
vi.mock('@/server/services/market', () => ({ MarketService: vi.fn() }));
vi.mock('@/server/services/governance', () => ({
  checkCommand: mocks.checkCommand,
  checkPath: mocks.checkPath,
  COMMAND_BLOCKED_MESSAGE: 'blocked',
  FILE_BLOCKED_MESSAGE: 'blocked file',
  GOVERNANCE_UNAVAILABLE_MESSAGE: 'temporarily unavailable',
  GovernanceUnavailableError: mocks.GovernanceUnavailableError,
  logCommandExecution: mocks.audit,
}));
const { BuiltinToolsExecutor } = await import('../builtin');
beforeEach(() => {
  vi.resetAllMocks();
  mocks.checkCommand.mockResolvedValue({ allowed: true });
  mocks.checkPath.mockResolvedValue({ allowed: true });
  mocks.run.mockResolvedValue({ content: 'ok', success: true });
});
afterEach(() => vi.restoreAllMocks());

it.each(['runCommand', 'writeFile'])(
  'does not execute %s or report a rule denial during a governance outage',
  async (apiName) => {
    const gate = apiName === 'runCommand' ? mocks.checkCommand : mocks.checkPath;
    gate.mockRejectedValue(new mocks.GovernanceUnavailableError());
    const executor = new BuiltinToolsExecutor({} as LobeChatDatabase, 'user-1');
    const result = await executor.execute(
      {
        apiName,
        arguments: JSON.stringify({ command: 'ls', path: '/tmp/file', content: 'text' }),
        id: 'tool-1',
        identifier: 'lobe-local-system',
        type: 'builtin',
      } as ChatToolPayload,
      { userId: 'user-1' },
    );
    expect(result).toMatchObject({ success: false, error: { code: 'GOVERNANCE_UNAVAILABLE' } });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  },
);
