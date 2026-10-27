import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SandboxProvider } from '../types';

const mocks = vi.hoisted(() => ({
  GovernanceUnavailableError: class GovernanceUnavailableError extends Error {
    readonly code = 'GOVERNANCE_UNAVAILABLE';
  },
  callTenantSandboxTool: vi.fn(),
  checkCommand: vi.fn(),
  isGovernanceEnabled: vi.fn(),
  logCommandExecution: vi.fn(),
}));

vi.mock('../tenantWork', () => ({ callTenantSandboxTool: mocks.callTenantSandboxTool }));
vi.mock('@/server/services/governance', () => ({
  checkCommand: mocks.checkCommand,
  isGovernanceEnabled: mocks.isGovernanceEnabled,
  COMMAND_BLOCKED_MESSAGE: 'blocked by an administrator rule; never retry',
  GOVERNANCE_UNAVAILABLE_MESSAGE: 'governance unavailable; temporary',
  GovernanceUnavailableError: mocks.GovernanceUnavailableError,
  logCommandExecution: mocks.logCommandExecution,
}));

const { SandboxMiddlewareService } = await import('../service');

const provider = {
  callTool: vi.fn(),
  capabilities: { shell: false },
  kind: 'onlyboxes',
} as unknown as SandboxProvider;

const service = () =>
  new SandboxMiddlewareService(provider, { serverDB: {} as never, userId: 'user-1' });

afterEach(() => vi.restoreAllMocks());

describe('SandboxMiddlewareService command governance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isGovernanceEnabled.mockResolvedValue(true);
    mocks.checkCommand.mockResolvedValue({ allowed: true });
    mocks.callTenantSandboxTool.mockResolvedValue({ result: { exitCode: 0 }, success: true });
  });

  it('runs the command when governance allows it (flag off, or no rule matches)', async () => {
    const result = await service().callTool('runCommand', { command: 'ls' });

    expect(result.success).toBe(true);
    expect(mocks.callTenantSandboxTool).toHaveBeenCalledOnce();
  });

  it('denies with COMMAND_BLOCKED and records it when a rule matches', async () => {
    mocks.checkCommand.mockResolvedValue({ allowed: false, ruleId: 'rule-1' });

    const result = await service().callTool('runCommand', { command: 'rm -rf /' });

    expect(result).toMatchObject({ error: { name: 'COMMAND_BLOCKED' }, success: false });
    expect(mocks.callTenantSandboxTool).not.toHaveBeenCalled();
    expect(mocks.logCommandExecution).toHaveBeenCalledWith(
      expect.anything(),
      { blocked: true, matchedRuleId: 'rule-1' },
      expect.anything(),
    );
  });

  it('does not run the command, and does not call it blocked, when the governance flag cannot be read', async () => {
    mocks.checkCommand.mockRejectedValue(new mocks.GovernanceUnavailableError());

    const result = await service().callTool('execScript', { command: 'ls' });

    expect(result).toMatchObject({
      error: { message: 'governance unavailable; temporary', name: 'GOVERNANCE_UNAVAILABLE' },
      result: null,
      success: false,
    });
    expect(mocks.callTenantSandboxTool).not.toHaveBeenCalled();
    expect(mocks.logCommandExecution).not.toHaveBeenCalled();
  });

  it('rethrows any other governance error rather than hiding it', async () => {
    mocks.checkCommand.mockRejectedValue(new Error('boom'));

    await expect(service().callTool('runCommand', { command: 'ls' })).rejects.toThrow('boom');
    expect(mocks.callTenantSandboxTool).not.toHaveBeenCalled();
  });

  it('denies shell execution when the database context is missing', async () => {
    const withoutDB = new SandboxMiddlewareService(provider, { userId: 'user-1' });
    const result = await withoutDB.callTool('runCommand', { command: 'ls' });
    expect(result).toMatchObject({ success: false, error: { name: 'GOVERNANCE_UNAVAILABLE' } });
    expect(mocks.callTenantSandboxTool).not.toHaveBeenCalled();
  });

  it('denies shell execution when the switch cannot be read without database context', async () => {
    mocks.isGovernanceEnabled.mockRejectedValueOnce(new mocks.GovernanceUnavailableError());
    const withoutDB = new SandboxMiddlewareService(provider, { userId: 'user-1' });
    const result = await withoutDB.callTool('runCommand', { command: 'ls' });
    expect(result).toMatchObject({ success: false, error: { name: 'GOVERNANCE_UNAVAILABLE' } });
    expect(mocks.callTenantSandboxTool).not.toHaveBeenCalled();
  });

  it('reports an audit failure while preserving successful execution', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.logCommandExecution.mockRejectedValueOnce(new Error('audit unavailable'));
    const result = await service().callTool('runCommand', { command: 'ls' });
    expect(result.success).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it('allows shell execution without database context when explicitly off', async () => {
    mocks.isGovernanceEnabled.mockResolvedValue(false);
    const withoutDB = new SandboxMiddlewareService(provider, { userId: 'user-1' });
    const result = await withoutDB.callTool('runCommand', { command: 'ls' });
    expect(result.success).toBe(true);
  });

  it('does not govern tools that are not shell commands', async () => {
    await service().callTool('readFile', { path: '/a' });

    expect(mocks.checkCommand).not.toHaveBeenCalled();
    expect(mocks.callTenantSandboxTool).toHaveBeenCalledOnce();
  });

  it('governs executeCode on its real code field and runs when allowed', async () => {
    const result = await service().callTool('executeCode', {
      code: 'print("ok")',
      language: 'python',
    });

    expect(result.success).toBe(true);
    expect(mocks.checkCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        apiName: 'executeCode',
        commandText: 'print("ok")',
        executionTarget: 'sandbox',
        toolIdentifier: 'lobe-cloud-sandbox',
        userId: 'user-1',
      }),
      expect.anything(),
    );
    expect(mocks.callTenantSandboxTool).toHaveBeenCalledWith(
      expect.anything(),
      'executeCode',
      { code: 'print("ok")', language: 'python' },
      expect.anything(),
    );
  });

  it.each(['python', 'javascript', 'typescript'] as const)(
    'governs executeCode for language %s',
    async (language) => {
      vi.clearAllMocks();
      mocks.isGovernanceEnabled.mockResolvedValue(true);
      mocks.checkCommand.mockResolvedValue({ allowed: true });
      mocks.callTenantSandboxTool.mockResolvedValue({ result: { output: 'ok' }, success: true });

      const code = language === 'python' ? 'print("ok")' : 'console.log("ok")';
      await service().callTool('executeCode', { code, language });

      expect(mocks.checkCommand).toHaveBeenCalledWith(
        expect.objectContaining({ commandText: code }),
        expect.anything(),
      );
    },
  );

  it('denies executeCode without running and audits the real code', async () => {
    mocks.checkCommand.mockResolvedValue({ allowed: false, ruleId: 'rule-code' });

    const result = await service().callTool('executeCode', {
      code: 'import os; os.system("rm")',
      language: 'python',
    });

    expect(result).toMatchObject({ error: { name: 'COMMAND_BLOCKED' }, success: false });
    expect(mocks.callTenantSandboxTool).not.toHaveBeenCalled();
    expect(mocks.logCommandExecution).toHaveBeenCalledWith(
      expect.objectContaining({ commandText: 'import os; os.system("rm")' }),
      { blocked: true, matchedRuleId: 'rule-code' },
      expect.anything(),
    );
  });

  it('fails closed for executeCode when governance is unavailable', async () => {
    mocks.checkCommand.mockRejectedValue(new mocks.GovernanceUnavailableError());

    const result = await service().callTool('executeCode', {
      code: 'print("ok")',
      language: 'python',
    });

    expect(result).toMatchObject({
      error: { name: 'GOVERNANCE_UNAVAILABLE' },
      success: false,
    });
    expect(mocks.callTenantSandboxTool).not.toHaveBeenCalled();
    expect(mocks.logCommandExecution).not.toHaveBeenCalled();
  });

  it('never lets an attacker-supplied command field override executeCode code', async () => {
    const realCode = 'import os; os.system("evil")';
    await service().callTool('executeCode', {
      code: realCode,
      command: 'echo innocent',
      language: 'python',
    });

    expect(mocks.checkCommand).toHaveBeenCalledWith(
      expect.objectContaining({ commandText: realCode }),
      expect.anything(),
    );
  });
});
