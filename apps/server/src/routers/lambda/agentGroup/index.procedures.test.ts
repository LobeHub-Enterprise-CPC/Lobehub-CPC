// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { agentGroupRouter } from '.';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('agentGroupRouter procedures', () => {
  const procedures = (agentGroupRouter as any)._def.procedures as Record<string, any>;

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
    ['acquireGroupLock', 'mutation', 14],
    ['addAgentsToGroup', 'mutation', 14],
    ['batchCreateAgentsInGroup', 'mutation', 14],
    ['checkAgentsBeforeRemoval', 'query', 13],
    ['createGroup', 'mutation', 14],
    ['createGroupWithMembers', 'mutation', 14],
    ['deleteGroup', 'mutation', 14],
    ['duplicateGroup', 'mutation', 14],
    ['getGroup', 'query', 13],
    ['getGroupAgents', 'query', 13],
    ['getGroupByForkedFromIdentifier', 'query', 13],
    ['getGroupDetail', 'query', 13],
    ['getGroupLock', 'query', 14],
    ['getGroups', 'query', 12],
    ['getTransferJobStatus', 'query', 13],
    ['listReferencedMembers', 'query', 13],
    ['publishGroupToWorkspace', 'mutation', 14],
    ['releaseGroupLock', 'mutation', 14],
    ['removeAgentsFromGroup', 'mutation', 14],
    ['setGroupVisibility', 'mutation', 14],
    ['transferGroup', 'mutation', 14],
    ['updateAgentInGroup', 'mutation', 14],
    ['updateGroup', 'mutation', 14],
  ];
}
