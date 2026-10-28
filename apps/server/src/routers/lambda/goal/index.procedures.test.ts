// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { goalRouter } from '.';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('goalRouter procedures', () => {
  const procedures = (goalRouter as any)._def.procedures as Record<string, any>;

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
    ['addEdge', 'mutation', 14],
    ['addNode', 'mutation', 14],
    ['advance', 'mutation', 14],
    ['answerClarifications', 'mutation', 14],
    ['bindOperationTopic', 'mutation', 8],
    ['bindTopic', 'mutation', 14],
    ['close', 'mutation', 14],
    ['create', 'mutation', 14],
    ['createConversationGoal', 'mutation', 8],
    ['decide', 'mutation', 14],
    ['delete', 'mutation', 14],
    ['events', 'query', 13],
    ['eventsOperation', 'query', 9],
    ['graph', 'query', 13],
    ['graphOperation', 'query', 9],
    ['list', 'query', 13],
    ['metricState', 'query', 13],
    ['metricStateOperation', 'query', 9],
    ['pause', 'mutation', 14],
    ['pendingClarifications', 'query', 12],
    ['pendingForIsland', 'query', 12],
    ['planContext', 'query', 13],
    ['planContextOperation', 'query', 9],
    ['recordObservation', 'mutation', 14],
    ['removeEdge', 'mutation', 14],
    ['removeMetricCriteria', 'mutation', 14],
    ['restart', 'mutation', 14],
    ['resume', 'mutation', 14],
    ['retireNodes', 'mutation', 14],
    ['setAcceptanceCriteria', 'mutation', 14],
    ['setAgent', 'mutation', 14],
    ['setBudget', 'mutation', 14],
    ['setMetricCriteria', 'mutation', 14],
    ['setModel', 'mutation', 14],
    ['setTaskAgent', 'mutation', 14],
    ['setTaskModel', 'mutation', 14],
    ['start', 'mutation', 14],
    ['startOperation', 'mutation', 8],
    ['submitOperationPlan', 'mutation', 8],
    ['submitOperationReport', 'mutation', 8],
    ['submitPlan', 'mutation', 14],
    ['submitReport', 'mutation', 14],
    ['supervision', 'query', 13],
    ['tick', 'mutation', 14],
    ['updateRequirement', 'mutation', 14],
    ['wake', 'mutation', 14],
  ];
}
