import type { ChatToolPayload } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BuiltinToolsExecutor } from './builtin';
import type { ToolExecutionContext } from './types';

const mocks = vi.hoisted(() => ({
  apiHandler: vi.fn(),
  checkCommand: vi.fn().mockResolvedValue({ allowed: true }),
  checkPath: vi.fn().mockResolvedValue({ allowed: true }),
  executeLobehubSkill: vi.fn(),
  logCommandExecution: vi.fn().mockResolvedValue(undefined),
  // The real class lives in policyGate; the executor only needs `instanceof` to hold.
  GovernanceUnavailableError: class GovernanceUnavailableError extends Error {
    readonly code = 'GOVERNANCE_UNAVAILABLE';
  },
}));
vi.mock('./serverRuntimes', () => ({
  hasServerRuntime: vi.fn().mockReturnValue(true),
  getServerRuntime: vi.fn(async () => ({
    createDocument: mocks.apiHandler,
    getCommandOutput: mocks.apiHandler,
    runCommand: mocks.apiHandler,
    searchUserMemory: mocks.apiHandler,
  })),
}));

vi.mock('@/server/services/composio', () => ({
  ComposioService: vi.fn().mockImplementation(function () {
    return {};
  }),
}));
vi.mock('@/server/services/market', () => ({
  MarketService: vi.fn().mockImplementation(function () {
    return {
      executeLobehubSkill: mocks.executeLobehubSkill,
    };
  }),
}));
// Governance is mocked here purely to isolate BuiltinToolsExecutor's wiring
// (does it call checkCommand/logCommandExecution with the right shape, does a
// denial short-circuit, does a logging failure stay non-fatal) — policyGate's
// own matching/fail-open behavior has its own unit tests in
// `services/governance/__tests__/policyGate.test.ts`.
vi.mock('@/server/services/governance', () => ({
  checkCommand: mocks.checkCommand,
  checkPath: mocks.checkPath,
  COMMAND_BLOCKED_MESSAGE:
    'This command was blocked by an administrator-configured command governance rule for this user. Do not attempt this action again in any form.',
  GOVERNANCE_UNAVAILABLE_MESSAGE: 'Command governance could not be evaluated right now. Temporary.',
  GovernanceUnavailableError: mocks.GovernanceUnavailableError,
  FILE_BLOCKED_MESSAGE:
    'This file operation was blocked by an administrator-configured execution policy for this user. Do not attempt to read or write this path again in any form.',
  logCommandExecution: mocks.logCommandExecution,
}));

// The runtime mock above only exposes `createDocument`, but the manifest is the
// authoritative source of declared APIs — it also lists `listDocuments`, so an
// UNKNOWN_API hint sourced from the manifest must surface both.
//
// The share-gate exports mirror the real module's semantics on this mock's
// registry: both mocked identifiers are "builtin", neither is share-allowed —
// except `lobe-user-memory`, granted so the memory-permission dispatch tests
// below can exercise the per-API data-tool rules.
vi.mock('@lobechat/builtin-tools', () => ({
  AGENT_SHARE_ALLOWED_BUILTIN_IDENTIFIERS: new Set(['lobe-user-memory']),
  isBuiltinToolIdentifier: (id: string) =>
    ['lobe-notebook', 'lobe-task', 'lobe-user-memory'].includes(id),
  builtinTools: [
    {
      identifier: 'lobe-notebook',
      manifest: { api: [{ name: 'createDocument' }, { name: 'listDocuments' }] },
    },
    {
      identifier: 'lobe-local-system',
      manifest: {
        api: [
          {
            name: 'runCommand',
            parameters: {
              properties: { command: { type: 'string' }, description: { type: 'string' } },
              required: ['description', 'command'],
              type: 'object',
            },
          },
          {
            name: 'getCommandOutput',
            parameters: { properties: { shell_id: { type: 'string' } }, type: 'object' },
          },
        ],
      },
    },
    {
      identifier: 'lobe-user-memory',
      manifest: {
        api: [
          { name: 'searchUserMemory' },
          { name: 'addContextMemory' },
          // intervention-gated: the dispatch gate must not re-block it
          { humanIntervention: 'required', name: 'consentGated' },
        ],
      },
    },
    {
      identifier: 'lobe-task',
      manifest: {
        api: [
          { name: 'createTask', work: { action: 'create', resourceType: 'task' } },
          { name: 'createTasks', work: { action: 'create', resourceType: 'task' } },
          { name: 'editTask', work: { action: 'update', resourceType: 'task' } },
          { name: 'listTasks' },
        ],
      },
    },
  ],
}));

const context: ToolExecutionContext = {
  toolManifestMap: {},
  userId: 'user-1',
};

describe('BuiltinToolsExecutor command governance hook', () => {
  const executor = new BuiltinToolsExecutor({} as any, 'user-1');

  beforeEach(() => {
    mocks.checkCommand.mockReset().mockResolvedValue({ allowed: true });
    mocks.logCommandExecution.mockReset().mockResolvedValue(undefined);
  });

  describe('cloud-sandbox executeCode is governed on its real code', () => {
    const codePayload: ChatToolPayload = {
      apiName: 'executeCode',
      arguments: '{"code":"print(\\"ok\\")","description":"demo","language":"python"}',
      id: 'tool-call-code',
      identifier: 'lobe-cloud-sandbox',
      type: 'default' as any,
    };

    it.each(['python', 'javascript', 'typescript'] as const)(
      'checks the true code for language %s and dispatches when allowed',
      async (language) => {
        const { getServerRuntime } = await import('./serverRuntimes');
        const code = language === 'python' ? 'print("ok")' : 'console.log("ok")';
        const executeCodeMock = vi.fn().mockResolvedValue({ content: 'done', success: true });
        vi.mocked(getServerRuntime).mockResolvedValueOnce({ executeCode: executeCodeMock } as any);

        const result = await executor.execute(
          {
            ...codePayload,
            arguments: JSON.stringify({ code, description: 'demo', language }),
          },
          context,
        );

        expect(mocks.checkCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            apiName: 'executeCode',
            commandText: code,
            executionTarget: 'sandbox',
            toolIdentifier: 'lobe-cloud-sandbox',
            userId: 'user-1',
          }),
          expect.anything(),
        );
        expect(executeCodeMock).toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(mocks.logCommandExecution).toHaveBeenCalledWith(
          expect.objectContaining({ commandText: code }),
          expect.objectContaining({ blocked: false, success: true }),
          expect.anything(),
        );
      },
    );

    it('returns COMMAND_BLOCKED and never calls the runtime when denied', async () => {
      mocks.checkCommand.mockReset().mockResolvedValueOnce({ allowed: false, ruleId: 'rule-code' });
      const { getServerRuntime } = await import('./serverRuntimes');
      const executeCodeMock = vi.fn();
      vi.mocked(getServerRuntime).mockResolvedValueOnce({ executeCode: executeCodeMock } as any);

      const result = await executor.execute(codePayload, context);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('COMMAND_BLOCKED');
      expect(executeCodeMock).not.toHaveBeenCalled();
    });

    it('returns GOVERNANCE_UNAVAILABLE and never calls the runtime on outage', async () => {
      mocks.checkCommand.mockReset().mockRejectedValueOnce(new mocks.GovernanceUnavailableError());
      const { getServerRuntime } = await import('./serverRuntimes');
      const executeCodeMock = vi.fn();
      vi.mocked(getServerRuntime).mockResolvedValueOnce({ executeCode: executeCodeMock } as any);

      const result = await executor.execute(codePayload, context);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GOVERNANCE_UNAVAILABLE');
      expect(executeCodeMock).not.toHaveBeenCalled();
      expect(mocks.logCommandExecution).not.toHaveBeenCalled();
    });

    it('never lets an attacker-supplied command field override the real code', async () => {
      const { getServerRuntime } = await import('./serverRuntimes');
      const executeCodeMock = vi.fn().mockResolvedValue({ content: 'done', success: true });
      vi.mocked(getServerRuntime).mockResolvedValueOnce({ executeCode: executeCodeMock } as any);

      const realCode = 'import os; os.system("evil")';
      await executor.execute(
        {
          ...codePayload,
          arguments: JSON.stringify({
            code: realCode,
            command: 'echo innocent',
            description: 'demo',
            language: 'python',
          }),
        },
        context,
      );

      expect(mocks.checkCommand).toHaveBeenCalledWith(
        expect.objectContaining({ commandText: realCode }),
        expect.anything(),
      );
    });
  });
});
