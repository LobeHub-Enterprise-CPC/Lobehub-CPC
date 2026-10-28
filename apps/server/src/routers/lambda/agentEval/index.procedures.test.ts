// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { agentEvalRouter } from './index';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('agentEvalRouter procedures', () => {
  const procedures = (agentEvalRouter as any)._def.procedures as Record<string, any>;

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
    ['abortRun', 'mutation', 14],
    ['batchCreateTestCases', 'mutation', 14],
    ['batchResumeRunCases', 'mutation', 14],
    ['createBenchmark', 'mutation', 14],
    ['createDataset', 'mutation', 14],
    ['createExperiment', 'mutation', 14],
    ['createRun', 'mutation', 14],
    ['createTestCase', 'mutation', 14],
    ['deleteBenchmark', 'mutation', 14],
    ['deleteDataset', 'mutation', 14],
    ['deleteExperiment', 'mutation', 14],
    ['deleteRun', 'mutation', 14],
    ['deleteTestCase', 'mutation', 14],
    ['getBenchmark', 'query', 13],
    ['getDataset', 'query', 13],
    ['getExperiment', 'query', 13],
    ['getResumableCases', 'query', 13],
    ['getRunDetails', 'query', 13],
    ['getRunProgress', 'query', 13],
    ['getRunResults', 'query', 13],
    ['getTestCase', 'query', 13],
    ['importDataset', 'mutation', 14],
    ['listBenchmarks', 'query', 13],
    ['listDatasets', 'query', 13],
    ['listExperiments', 'query', 12],
    ['listRuns', 'query', 13],
    ['listTestCases', 'query', 13],
    ['parseDatasetFile', 'mutation', 14],
    ['resumeRunCase', 'mutation', 14],
    ['retryRunCase', 'mutation', 14],
    ['retryRunErrors', 'mutation', 14],
    ['startRun', 'mutation', 14],
    ['updateBenchmark', 'mutation', 14],
    ['updateDataset', 'mutation', 14],
    ['updateExperiment', 'mutation', 14],
    ['updateRun', 'mutation', 14],
    ['updateRunMetrics', 'mutation', 14],
    ['updateRunStatus', 'mutation', 14],
    ['updateTestCase', 'mutation', 14],
  ];
}
