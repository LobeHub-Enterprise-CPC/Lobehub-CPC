// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { aiAgentRouter } from '.';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('aiAgentRouter procedures', () => {
  const procedures = (aiAgentRouter as any)._def.procedures as Record<string, any>;

  it('exposes exactly the expected procedure paths', () => {
    expect(Object.keys(procedures).sort()).toEqual(expected().map(([name]) => name));
  });

  it.each(expected())('%s is a %s with %i middlewares', (name, type, middlewares) => {
    expect(procedures[name]._def.type).toBe(type);
    expect(procedures[name]._def.middlewares).toHaveLength(middlewares);
  });
});

function expected(): Array<[name: string, type: 'mutation' | 'query', middlewares: number]> {
  return [
    ['beginServerDefaultHeterogeneousOperation', 'mutation', 12],
    ['cancelServerDefaultHeterogeneousOperation', 'mutation', 12],
    ['createClientGroupAgentTaskThread', 'mutation', 14],
    ['createClientTaskThread', 'mutation', 14],
    ['describeServerDefaultHeterogeneousModel', 'mutation', 12],
    ['execAgent', 'mutation', 14],
    ['execAgents', 'mutation', 14],
    ['execGroupAgent', 'mutation', 14],
    ['execSubAgentTask', 'mutation', 14],
    ['finishServerDefaultHeterogeneousOperation', 'mutation', 12],
    ['getAgentInterventionReview', 'mutation', 12],
    ['getAgentInterventionReviewBySource', 'mutation', 12],
    ['getHeteroInterventionReview', 'mutation', 12],
    ['getOperationStatus', 'query', 13],
    ['getPendingInterventions', 'query', 13],
    ['getServerDefaultHeterogeneousCapability', 'query', 11],
    ['getSubAgentTaskStatus', 'query', 13],
    ['heteroFinish', 'mutation', 8],
    ['heteroIngest', 'mutation', 8],
    ['interruptTask', 'mutation', 14],
    ['issueGatewayUserToken', 'query', 12],
    ['listClientLlmWaits', 'query', 13],
    ['processHumanIntervention', 'mutation', 14],
    ['refreshGatewayToken', 'query', 13],
    ['refreshHeteroOperationToken', 'mutation', 8],
    ['releaseSubAgentLlmRelay', 'mutation', 14],
    ['resolveAgentIntervention', 'mutation', 14],
    ['resolveAgentInterventionBySource', 'mutation', 14],
    ['resolveHeteroIntervention', 'mutation', 14],
    ['resumeClientLlmWait', 'mutation', 14],
    ['scheduleAgentRun', 'mutation', 14],
    ['setQueuedMessages', 'mutation', 14],
    ['startExecution', 'mutation', 14],
    ['stopPendingApproval', 'mutation', 14],
    ['submitHeteroIntervention', 'mutation', 14],
    ['updateClientTaskThreadStatus', 'mutation', 14],
    ['waitInterventionResponse', 'query', 8],
  ];
}
