import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  flags: { command_governance: false },
  getPolicyForUser: vi.fn(),
  getFlags: vi.fn(),
}));

vi.mock('@/server/featureFlags', () => ({
  getServerFeatureFlagsFromRuntimeConfig: mocks.getFlags,
}));
vi.mock('../executionPolicyRepository', () => ({
  getPolicyForUser: async (...args: unknown[]) => {
    const policy = await mocks.getPolicyForUser(...args);
    return policy ? { enabled: true, ...policy } : policy;
  },
}));

const { GovernanceUnavailableError } = await import('../policyGate');
const { checkPath, FILE_BLOCKED_MESSAGE, pathMatchesRoot } = await import('../pathPolicy');

const baseCtx = {
  apiName: 'writeFile',
  executionTarget: 'device' as const,
  path: '/home/alice/.ssh/config',
  toolIdentifier: 'lobe-local-system',
  userId: 'user-1',
};

const db = {} as any;

afterEach(() => vi.restoreAllMocks());

describe('pathMatchesRoot', () => {
  it('matches a half-width ~ root against a resolved absolute path', () => {
    expect(pathMatchesRoot('/home/alice/.ssh/config', '~/.ssh')).toBe(true);
  });

  it('matches a full-width ～ root the same way — this is the original bug', () => {
    expect(pathMatchesRoot('/home/alice/.ssh/config', '～/.ssh')).toBe(true);
  });

  it('matches a Windows path against a POSIX-style root', () => {
    expect(pathMatchesRoot('C:\\Users\\lijian\\.ssh\\test_env.txt', '~/.ssh')).toBe(true);
  });

  it('matches the root exactly, not just as a prefix of a longer segment', () => {
    expect(pathMatchesRoot('/home/alice/.ssh2/config', '~/.ssh')).toBe(false);
  });

  it('does not match an unrelated path', () => {
    expect(pathMatchesRoot('/home/alice/Desktop/notes.txt', '~/.ssh')).toBe(false);
  });

  it('matches an absolute root as a path prefix, not as a trailing segment', () => {
    expect(pathMatchesRoot('/etc/secrets', '/etc/secrets')).toBe(true);
    expect(pathMatchesRoot('/etc/secrets/db/key.pem', '/etc/secrets')).toBe(true);
    expect(pathMatchesRoot('/etc/secrets/db/key.pem', '/etc/secrets/')).toBe(true);
    expect(pathMatchesRoot('C:\\Secrets\\key.pem', 'C:/Secrets')).toBe(true);
  });

  it('does not let an absolute root match a sibling or a nested lookalike', () => {
    expect(pathMatchesRoot('/etc/secrets2/key.pem', '/etc/secrets')).toBe(false);
    expect(pathMatchesRoot('/srv/etc/secrets/key.pem', '/etc/secrets')).toBe(false);
  });

  it('resolves dot segments before comparing an absolute root', () => {
    expect(pathMatchesRoot('/tmp/../etc/secrets/key.pem', '/etc/secrets')).toBe(true);
    expect(pathMatchesRoot('/etc/secrets/../public/a', '/etc/secrets')).toBe(false);
  });

  it('is a known, accepted imprecision: a coincidental directory name still matches', () => {
    // Suffix/substring matching (chosen because the server cannot resolve a
    // remote device's real home directory) cannot tell "~/.ssh" apart from an
    // unrelated directory that happens to be named ".ssh" elsewhere. Documented
    // tradeoff, not a bug — see pathPolicy.ts's doc comment.
    expect(pathMatchesRoot('/data/backup/.ssh', '~/.ssh')).toBe(true);
  });
});

describe('checkPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flags = { command_governance: false };
    mocks.getFlags.mockImplementation(async () => mocks.flags);
  });

  it('allows without querying the policy when governance is disabled', async () => {
    const decision = await checkPath(baseCtx, db);

    expect(decision).toEqual({ allowed: true });
    expect(mocks.getPolicyForUser).not.toHaveBeenCalled();
  });

  it('rejects when the switch cannot be read', async () => {
    mocks.getFlags.mockRejectedValueOnce(new Error('unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(checkPath(baseCtx, db)).rejects.toBeInstanceOf(GovernanceUnavailableError);
    expect(mocks.getPolicyForUser).not.toHaveBeenCalled();
  });

  describe('governance enabled', () => {
    beforeEach(() => {
      mocks.flags = { command_governance: true };
    });

    it('allows when the user has no policy configured', async () => {
      mocks.getPolicyForUser.mockResolvedValueOnce(null);

      const decision = await checkPath(baseCtx, db);

      expect(decision).toEqual({ allowed: true });
    });

    it('allows when the policy has no denied roots for this direction', async () => {
      mocks.getPolicyForUser.mockResolvedValueOnce({ deniedWriteRoots: [] });

      const decision = await checkPath(baseCtx, db);

      expect(decision).toEqual({ allowed: true });
    });

    it('denies a write under deniedWriteRoots and reports which field matched', async () => {
      mocks.getPolicyForUser.mockResolvedValueOnce({ deniedWriteRoots: ['~/.ssh'] });

      const decision = await checkPath(baseCtx, db);

      expect(decision).toEqual({ allowed: false, matchedField: 'deniedWriteRoots' });
    });

    it('checks reads against deniedReadRoots, not deniedWriteRoots', async () => {
      mocks.getPolicyForUser.mockResolvedValueOnce({
        deniedReadRoots: ['~/.ssh'],
        deniedWriteRoots: [],
      });

      const decision = await checkPath({ ...baseCtx, apiName: 'readFile' }, db);

      expect(decision).toEqual({ allowed: false, matchedField: 'deniedReadRoots' });
    });

    it('does not deny a write against a deniedReadRoots-only policy', async () => {
      mocks.getPolicyForUser.mockResolvedValueOnce({
        deniedReadRoots: ['~/.ssh'],
        deniedWriteRoots: [],
      });

      const decision = await checkPath(baseCtx, db);

      expect(decision).toEqual({ allowed: true });
    });

    it('rejects when the policy lookup throws', async () => {
      mocks.getPolicyForUser.mockRejectedValueOnce(new Error('DB is down'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(checkPath(baseCtx, db)).rejects.toBeInstanceOf(GovernanceUnavailableError);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });
});

describe('FILE_BLOCKED_MESSAGE', () => {
  // Mirrors COMMAND_BLOCKED_MESSAGE's rationale (policyGate.test.ts) — a model
  // that only sees "this path is blocked" has been observed retrying a nearby
  // path instead of stopping.
  it('explicitly tells the model to stop and never retry', () => {
    const message = FILE_BLOCKED_MESSAGE.toLowerCase();

    expect(message).toContain('do not attempt to read or write this path again');
    expect(message).toContain('blocked again');
    expect(message).toContain('stop this line of action');
  });
});
