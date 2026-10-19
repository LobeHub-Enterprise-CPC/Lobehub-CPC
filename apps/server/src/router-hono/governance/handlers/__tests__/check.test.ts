import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  flags: { command_governance: false } as Record<string, boolean | string[]>,
  getServerDB: vi.fn(),
  getServerFeatureFlagsFromRuntimeConfig: vi.fn(),
  insertLog: vi.fn(),
  listEnabledRulesForTarget: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: mocks.getServerDB }));
vi.mock('@/server/featureFlags', () => ({
  getServerFeatureFlagsFromRuntimeConfig: mocks.getServerFeatureFlagsFromRuntimeConfig,
}));
vi.mock('@/server/services/governance/rulesRepository', () => ({
  listEnabledRulesForTarget: mocks.listEnabledRulesForTarget,
}));
vi.mock('@/server/services/governance/logsRepository', () => ({ insertLog: mocks.insertLog }));

const { check } = await import('../check');
const { log } = await import('../log');

const app = new Hono().post('/check', check).post('/log', log);

const body = {
  apiName: 'runCommand',
  commandText: 'rm -rf /',
  executionTarget: 'sandbox',
  toolIdentifier: 'cloud-sandbox',
  userId: 'user-1',
};
const post = (path: string, payload: unknown = body) =>
  app.request(path, {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.flags = { command_governance: false };
  mocks.getServerFeatureFlagsFromRuntimeConfig.mockImplementation(async () => mocks.flags);
  mocks.getServerDB.mockResolvedValue({});
  mocks.listEnabledRulesForTarget.mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

describe('POST /api/governance/check', () => {
  it('allows without opening a database connection when the flag is explicitly off', async () => {
    const response = await post('/check');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: true });
    expect(mocks.getServerDB).not.toHaveBeenCalled();
  });

  it('applies the rules when the flag is on', async () => {
    mocks.flags = { command_governance: true };
    mocks.listEnabledRulesForTarget.mockResolvedValueOnce([
      { id: 'rule-1', pattern: 'rm -rf', patternType: 'prefix' },
    ]);

    const response = await post('/check');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: false, ruleId: 'rule-1' });
  });

  it('allows a command no rule matches when the flag is on', async () => {
    mocks.flags = { command_governance: true };

    const response = await post('/check');

    expect(await response.json()).toEqual({ allowed: true });
  });

  // `{allowed:false}` would reach the model as an administrator policy decision ("do not retry");
  // an unreadable flag is a governance outage, so the caller gets a server error it denies on and
  // can retry, and monitoring sees a 5xx.
  it('answers 503 GOVERNANCE_UNAVAILABLE, not an allow or a policy deny, when the flag cannot be read', async () => {
    mocks.getServerFeatureFlagsFromRuntimeConfig.mockRejectedValueOnce(new Error('Redis down'));

    const response = await post('/check');

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    const json = await response.json();
    expect(json).toEqual({ error: 'GOVERNANCE_UNAVAILABLE' });
    expect(json).not.toHaveProperty('allowed');
    expect(mocks.listEnabledRulesForTarget).not.toHaveBeenCalled();
  });

  it.each(['rules', 'connection'])('returns 503 when the %s lookup fails', async (failure) => {
    mocks.flags = { command_governance: true };
    const dependency = failure === 'rules' ? mocks.listEnabledRulesForTarget : mocks.getServerDB;
    dependency.mockRejectedValueOnce(new Error('unavailable'));
    const response = await post('/check');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toEqual({ error: 'GOVERNANCE_UNAVAILABLE' });
  });

  it('still rejects an invalid body with 400 before reading the flag', async () => {
    const response = await post('/check', { userId: 'user-1' });

    expect(response.status).toBe(400);
    expect(mocks.getServerFeatureFlagsFromRuntimeConfig).not.toHaveBeenCalled();
  });
});

describe('POST /api/governance/log', () => {
  const logBody = { ...body, outcome: { blocked: false, success: true } };

  it('records nothing and answers 204 when the flag is explicitly off', async () => {
    const response = await post('/log', logBody);

    expect(response.status).toBe(204);
    expect(mocks.insertLog).not.toHaveBeenCalled();
  });

  it('records the outcome when the flag is on', async () => {
    mocks.flags = { command_governance: true };

    const response = await post('/log', logBody);

    expect(response.status).toBe(204);
    expect(mocks.insertLog).toHaveBeenCalledOnce();
  });

  it('answers 503 GOVERNANCE_UNAVAILABLE when the flag cannot be read, so the caller knows the entry was not recorded', async () => {
    mocks.getServerFeatureFlagsFromRuntimeConfig.mockRejectedValueOnce(new Error('Redis down'));

    const response = await post('/log', logBody);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'GOVERNANCE_UNAVAILABLE' });
    expect(mocks.insertLog).not.toHaveBeenCalled();
  });
});
