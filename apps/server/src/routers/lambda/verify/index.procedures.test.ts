// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { verifyRouter } from '.';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('verifyRouter procedures', () => {
  const procedures = (verifyRouter as any)._def.procedures as Record<string, any>;

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
    ['confirmPlan', 'mutation', 14],
    ['createCriteria', 'mutation', 14],
    ['createCriterion', 'mutation', 14],
    ['createRubric', 'mutation', 14],
    ['createRun', 'mutation', 14],
    ['deleteCriterion', 'mutation', 14],
    ['deleteEvidence', 'mutation', 14],
    ['deleteResult', 'mutation', 14],
    ['deleteRubric', 'mutation', 14],
    ['deleteRun', 'mutation', 14],
    ['executeVerify', 'mutation', 14],
    ['forkRubricCriteria', 'mutation', 14],
    ['generateCriteria', 'mutation', 14],
    ['generateDraftPlan', 'mutation', 14],
    ['generateGoalCriteria', 'mutation', 14],
    ['generateGoalPlan', 'mutation', 14],
    ['getCriteria', 'query', 13],
    ['getCriterionResults', 'query', 13],
    ['getReport', 'query', 13],
    ['getReportBundle', 'query', 7],
    ['getRubric', 'query', 13],
    ['getRubricCriteria', 'query', 13],
    ['getRun', 'query', 13],
    ['getRunAcceptanceRound', 'query', 7],
    ['getSkillBundle', 'query', 6],
    ['getVerifierThread', 'query', 13],
    ['getVerifierTracing', 'query', 13],
    ['getVerifyState', 'query', 13],
    ['ingestResult', 'mutation', 14],
    ['listCriteria', 'query', 13],
    ['listEvidence', 'query', 13],
    ['listReportSummaries', 'query', 13],
    ['listResults', 'query', 13],
    ['listResultsByRun', 'query', 13],
    ['listRubrics', 'query', 12],
    ['listRuns', 'query', 12],
    ['regenerateReport', 'mutation', 14],
    ['setRubricCriteria', 'mutation', 14],
    ['setRunVisibility', 'mutation', 14],
    ['skipPlan', 'mutation', 14],
    ['submitCheckEvidence', 'mutation', 14],
    ['submitDecision', 'mutation', 14],
    ['updateCriterion', 'mutation', 14],
    ['updateDraftItems', 'mutation', 14],
    ['updateRubric', 'mutation', 14],
    ['updateRun', 'mutation', 14],
    ['uploadEvidence', 'mutation', 14],
    ['upsertReport', 'mutation', 14],
  ];
}
