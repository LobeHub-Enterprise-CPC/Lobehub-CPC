// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { agentRouter } from '.';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('agentRouter procedures', () => {
  const procedures = (agentRouter as any)._def.procedures as Record<string, any>;

  it('exposes exactly the expected procedure paths', () => {
    expect(Object.keys(procedures).sort()).toEqual(expected().map(([name]) => name));
  });

  it.each(expected())('%s is a %s with %i middlewares', (name, type, middlewares) => {
    expect(procedures[name]._def.type).toBe(type);
    expect(procedures[name]._def.middlewares).toHaveLength(middlewares);
  });
});

function expected(): Array<
  [name: string, type: 'mutation' | 'query' | 'subscription', middlewares: number]
> {
  return [
    ['acquireAgentLock', 'mutation', 14],
    ['checkByMarketIdentifier', 'query', 13],
    ['countAgents', 'query', 13],
    ['createAgent', 'mutation', 14],
    ['createAgentFiles', 'mutation', 14],
    ['createAgentKnowledgeBase', 'mutation', 14],
    ['createAgentOnly', 'mutation', 14],
    ['deleteAgentFile', 'mutation', 14],
    ['deleteAgentKnowledgeBase', 'mutation', 14],
    ['duplicateAgent', 'mutation', 14],
    ['getAgentByForkedFromIdentifier', 'query', 13],
    ['getAgentByMarketIdentifier', 'query', 13],
    ['getAgentConfig', 'query', 13],
    ['getAgentConfigById', 'query', 13],
    ['getAgentLock', 'query', 14],
    ['getBuiltinAgent', 'query', 13],
    ['getGroupMembershipImpact', 'query', 13],
    ['getKnowledgeBasesAndFiles', 'query', 13],
    ['getTransferJobStatus', 'query', 13],
    ['prioritizeTransferTopic', 'mutation', 13],
    ['publishAgentToWorkspace', 'mutation', 14],
    ['queryAgents', 'query', 13],
    ['rankAgents', 'query', 13],
    ['releaseAgentLock', 'mutation', 14],
    ['removeAgent', 'mutation', 14],
    ['resolveAgentIdBySlug', 'query', 13],
    ['resolveAgentRoute', 'query', 13],
    ['setAgentVisibility', 'mutation', 14],
    ['toggleFile', 'mutation', 14],
    ['toggleKnowledgeBase', 'mutation', 14],
    ['transferAgent', 'mutation', 14],
    ['transferAgents', 'mutation', 14],
    ['updateAgentConfig', 'mutation', 14],
    ['updateAgentPinned', 'mutation', 14],
    ['updateAgentSlug', 'mutation', 14],
  ];
}
