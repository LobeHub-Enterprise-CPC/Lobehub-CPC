import { type MarketSDK } from '@lobehub/market-sdk';
import { describe, expect, it, vi } from 'vitest';

import { guardProxyExecution, MarketContentWriteForbiddenError } from './proxyExecutionGuard';

const fakeSdk = () => {
  const agents = {
    createAgent: vi.fn(),
    getAgentDetail: vi.fn(async function (this: unknown) {
      return { self: this === agents };
    }),
    publish: vi.fn(),
  };
  return {
    agentGroups: { createAgentGroup: vi.fn(), getAgentGroupList: vi.fn() },
    agents,
    creds: { inject: vi.fn() },
    plugins: { runBuildInTool: vi.fn(async () => 'ran') },
    skills: { callTool: vi.fn(async () => 'called') },
    userPublish: { publishPlugin: vi.fn(), publishSkillVersion: vi.fn() },
  } as unknown as MarketSDK & Record<string, any>;
};

describe('guardProxyExecution', () => {
  // A share visitor's run executes as the creator: a publish from it would be
  // recorded as the creator's own act.
  it.each([
    ['agents', 'createAgent'],
    ['agents', 'publish'],
    ['agentGroups', 'createAgentGroup'],
    ['userPublish', 'publishPlugin'],
    ['userPublish', 'publishSkillVersion'],
  ])('refuses %s.%s', (namespace, method) => {
    const sdk = fakeSdk();
    const guarded = guardProxyExecution(sdk) as Record<string, any>;

    expect(() => guarded[namespace][method]({})).toThrowError(MarketContentWriteForbiddenError);
    expect(sdk[namespace][method]).not.toHaveBeenCalled();
  });

  it('names what was refused', () => {
    const guarded = guardProxyExecution(fakeSdk()) as Record<string, any>;

    expect(() => guarded.agents.createAgent({})).toThrowError(
      'MARKET_CONTENT_WRITE_FORBIDDEN:agents.createAgent',
    );
  });

  it('leaves the runtime surface a proxy run needs untouched', async () => {
    const sdk = fakeSdk();
    const guarded = guardProxyExecution(sdk) as Record<string, any>;

    await expect(guarded.plugins.runBuildInTool()).resolves.toBe('ran');
    await expect(guarded.skills.callTool()).resolves.toBe('called');
    await guarded.creds.inject();
    expect(sdk.creds.inject).toHaveBeenCalled();
    guarded.agentGroups.getAgentGroupList();
    expect(sdk.agentGroups.getAgentGroupList).toHaveBeenCalled();
  });

  it('keeps reads on the content namespaces bound to their own namespace', async () => {
    const guarded = guardProxyExecution(fakeSdk()) as Record<string, any>;

    await expect(guarded.agents.getAgentDetail()).resolves.toEqual({ self: true });
  });
});
