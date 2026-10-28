// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { acceptanceRouter } from '.';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('acceptanceRouter procedures', () => {
  const procedures = (acceptanceRouter as any)._def.procedures as Record<string, any>;

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
    ['accept', 'mutation', 14],
    ['addGroupFeedback', 'mutation', 14],
    ['adjudicateProposal', 'mutation', 14],
    ['attachRun', 'mutation', 14],
    ['completeFlow', 'mutation', 14],
    ['deleteFlow', 'mutation', 14],
    ['ensure', 'mutation', 14],
    ['getBundle', 'query', 7],
    ['getBySubject', 'query', 13],
    ['linkPullRequest', 'mutation', 14],
    ['list', 'query', 13],
    ['listPage', 'query', 13],
    ['listStatusesBySubjects', 'query', 13],
    ['markRepairing', 'mutation', 14],
    ['merge', 'mutation', 14],
    ['predictReviews', 'mutation', 14],
    ['publishFlow', 'mutation', 14],
    ['purgePreview', 'query', 13],
    ['recordFlowStep', 'mutation', 14],
    ['regroupChecks', 'mutation', 14],
    ['reject', 'mutation', 14],
    ['remove', 'mutation', 14],
    ['removeBatch', 'mutation', 14],
    ['rename', 'mutation', 14],
    ['reviewChecks', 'mutation', 14],
    ['reviewFlowStep', 'mutation', 14],
    ['saveChecklist', 'mutation', 14],
    ['saveGoal', 'mutation', 14],
    ['setPreviewUrl', 'mutation', 14],
    ['setProject', 'mutation', 14],
    ['setProjectBatch', 'mutation', 14],
    ['setVisibility', 'mutation', 14],
    ['startFlow', 'mutation', 14],
    ['unlinkPullRequest', 'mutation', 14],
    ['updateStatus', 'mutation', 14],
    ['updateStatusBatch', 'mutation', 14],
  ];
}
