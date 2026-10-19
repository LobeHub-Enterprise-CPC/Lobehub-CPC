import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  flags: { command_governance: false } as Record<string, boolean | string[]>,
  getServerFeatureFlagsFromRuntimeConfig: vi.fn(),
  listEnabledRulesForTarget: vi.fn(),
}));

vi.mock('@/server/featureFlags', () => ({
  getServerFeatureFlagsFromRuntimeConfig: mocks.getServerFeatureFlagsFromRuntimeConfig,
}));
vi.mock('../rulesRepository', () => ({
  listEnabledRulesForTarget: mocks.listEnabledRulesForTarget,
}));

const { checkCommand, COMMAND_BLOCKED_MESSAGE, GovernanceUnavailableError, isGovernanceEnabled } =
  await import('../policyGate');

const baseCtx = {
  apiName: 'runCommand',
  commandText: 'rm -rf /',
  executionTarget: 'device' as const,
  toolIdentifier: 'lobe-local-system',
  userId: 'user-1',
};

const db = {} as any;

afterEach(() => vi.restoreAllMocks());

describe('policyGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flags = { command_governance: false };
    mocks.getServerFeatureFlagsFromRuntimeConfig.mockImplementation(async () => mocks.flags);
  });

  describe('isGovernanceEnabled', () => {
    it.each([{}, { command_governance: null }, { command_governance: 'false' }])(
      'rejects missing or invalid switch configuration %j',
      async (flags) => {
        mocks.getServerFeatureFlagsFromRuntimeConfig.mockResolvedValueOnce(flags);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(isGovernanceEnabled('user-1')).rejects.toBeInstanceOf(
          GovernanceUnavailableError,
        );
      },
    );
    it('is false when the command_governance flag is off', async () => {
      expect(await isGovernanceEnabled('user-1')).toBe(false);
    });

    it('is true when the flag is on', async () => {
      mocks.flags = { command_governance: true };
      expect(await isGovernanceEnabled('user-1')).toBe(true);
    });

    it("follows the flag's user allowlist", async () => {
      mocks.flags = { command_governance: ['user-1'] };
      expect(await isGovernanceEnabled('user-1')).toBe(true);
      expect(await isGovernanceEnabled('user-2')).toBe(false);
    });

    it('fails closed when the flags cannot be read: the state is unknown, not off', async () => {
      mocks.getServerFeatureFlagsFromRuntimeConfig.mockRejectedValueOnce(new Error('Redis down'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(isGovernanceEnabled('user-1')).rejects.toBeInstanceOf(
        GovernanceUnavailableError,
      );

      consoleErrorSpy.mockRestore();
    });

    it('does not leak the underlying error message into the thrown error', async () => {
      mocks.getServerFeatureFlagsFromRuntimeConfig.mockRejectedValueOnce(
        new Error('connect ECONNREFUSED postgres://user:secret@db/runtime'),
      );
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const error = await isGovernanceEnabled('user-1').catch((e) => e);

      expect(error.code).toBe('GOVERNANCE_UNAVAILABLE');
      expect(error.message).not.toContain('secret');
      consoleErrorSpy.mockRestore();
    });
  });

  describe('checkCommand — flag off', () => {
    it('short-circuits to allowed=true without querying rules', async () => {
      const decision = await checkCommand(baseCtx, db);

      expect(decision).toEqual({ allowed: true });
      expect(mocks.listEnabledRulesForTarget).not.toHaveBeenCalled();
    });
  });

  describe('checkCommand — flag unreadable', () => {
    it('rejects instead of allowing, and never queries the rules', async () => {
      mocks.getServerFeatureFlagsFromRuntimeConfig.mockRejectedValueOnce(new Error('Redis down'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(checkCommand(baseCtx, db)).rejects.toBeInstanceOf(GovernanceUnavailableError);
      expect(mocks.listEnabledRulesForTarget).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('checkCommand — flag on, pattern matching', () => {
    beforeEach(() => {
      mocks.flags = { command_governance: true };
    });

    it('denies on an exact match', async () => {
      mocks.listEnabledRulesForTarget.mockResolvedValueOnce([
        { id: 'rule-1', pattern: 'rm -rf /', patternType: 'exact' },
      ]);

      const decision = await checkCommand(baseCtx, db);

      expect(decision).toEqual({ allowed: false, ruleId: 'rule-1' });
    });

    it('allows when no rule matches', async () => {
      mocks.listEnabledRulesForTarget.mockResolvedValueOnce([
        { id: 'rule-1', pattern: 'shutdown', patternType: 'exact' },
      ]);

      const decision = await checkCommand(baseCtx, db);

      expect(decision).toEqual({ allowed: true });
    });

    it('denies on a prefix match', async () => {
      mocks.listEnabledRulesForTarget.mockResolvedValueOnce([
        { id: 'rule-2', pattern: 'rm -rf', patternType: 'prefix' },
      ]);

      const decision = await checkCommand(baseCtx, db);

      expect(decision).toEqual({ allowed: false, ruleId: 'rule-2' });
    });

    it('does not deny a prefix rule that only matches a substring, not the start', async () => {
      mocks.listEnabledRulesForTarget.mockResolvedValueOnce([
        { id: 'rule-2', pattern: '-rf /', patternType: 'prefix' },
      ]);

      const decision = await checkCommand(baseCtx, db);

      expect(decision).toEqual({ allowed: true });
    });

    it('denies on a regex match', async () => {
      mocks.listEnabledRulesForTarget.mockResolvedValueOnce([
        { id: 'rule-3', pattern: '^rm\\s+-rf\\s+/', patternType: 'regex' },
      ]);

      const decision = await checkCommand(baseCtx, db);

      expect(decision).toEqual({ allowed: false, ruleId: 'rule-3' });
    });

    it('rejects when a configured regex cannot be evaluated', async () => {
      mocks.listEnabledRulesForTarget.mockResolvedValueOnce([
        { id: 'rule-bad', pattern: '(unterminated', patternType: 'regex' },
      ]);

      await expect(checkCommand(baseCtx, db)).rejects.toBeInstanceOf(GovernanceUnavailableError);
    });

    it('evaluates rules in order and denies on the first match', async () => {
      mocks.listEnabledRulesForTarget.mockResolvedValueOnce([
        { id: 'rule-no-match', pattern: 'shutdown', patternType: 'exact' },
        { id: 'rule-match', pattern: 'rm -rf', patternType: 'prefix' },
      ]);

      const decision = await checkCommand(baseCtx, db);

      expect(decision).toEqual({ allowed: false, ruleId: 'rule-match' });
    });
  });

  describe('checkCommand — fail closed', () => {
    beforeEach(() => {
      mocks.flags = { command_governance: true };
    });

    it('rejects when the rules lookup throws', async () => {
      mocks.listEnabledRulesForTarget.mockRejectedValueOnce(new Error('DB is down'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(checkCommand(baseCtx, db)).rejects.toBeInstanceOf(GovernanceUnavailableError);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('COMMAND_BLOCKED_MESSAGE', () => {
    // Both chokepoints (`toolExecution/builtin.ts`, `sandbox/service.ts`) surface
    // this exact string as the tool result when a command is denied. A model
    // that sees only "this was blocked" has been observed retrying the same
    // command, or a reworded one — the message must explicitly rule that out
    // rather than leave it to the model to infer.
    it('explicitly tells the model to stop and never retry', () => {
      const message = COMMAND_BLOCKED_MESSAGE.toLowerCase();

      expect(message).toContain('do not attempt this action again');
      expect(message).toContain('blocked again');
      expect(message).toContain('stop this line of action');
    });
  });
});
