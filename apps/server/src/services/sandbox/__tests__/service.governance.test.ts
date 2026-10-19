import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SandboxProvider } from '../types';

const mocks = vi.hoisted(() => ({
  GovernanceUnavailableError: class GovernanceUnavailableError extends Error {
    readonly code = 'GOVERNANCE_UNAVAILABLE';
  },
  callTenantSandboxTool: vi.fn(),
  checkCommand: vi.fn(),
  logCommandExecution: vi.fn(),
}));

vi.mock('../tenantWork', () => ({ callTenantSandboxTool: mocks.callTenantSandboxTool }));
vi.mock('@/server/services/governance', () => ({
  checkCommand: mocks.checkCommand,
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

describe('SandboxMiddlewareService command governance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('does not govern tools that are not shell commands', async () => {
    await service().callTool('readFile', { path: '/a' });

    expect(mocks.checkCommand).not.toHaveBeenCalled();
    expect(mocks.callTenantSandboxTool).toHaveBeenCalledOnce();
  });
});
