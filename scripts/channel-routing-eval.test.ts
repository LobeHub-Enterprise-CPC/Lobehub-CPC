// @vitest-environment node
import { writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runChannelRoutingEval } from './channel-routing-eval';

const { evaluate } = vi.hoisted(() => ({ evaluate: vi.fn() }));
vi.mock('ai', () => ({ experimental_evaluate: evaluate }));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const answer = { answers: { scope: { choice: 'all', probabilities: { all: 1 } } } };
const originalExitCode = process.exitCode;
const report = () => JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)![1] as string);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.stubEnv('AI_GATEWAY_API_KEY', 'test-only');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  evaluate.mockReset().mockResolvedValue(answer);
  process.exitCode = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

describe('Channel routing replay pacing', () => {
  it('awaits each response and waits 60 seconds before the next request across arms and turns', async () => {
    const starts: number[] = [];
    evaluate.mockImplementation(async () => {
      starts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return answer;
    });

    const pending = runChannelRoutingEval(['--allow-retention']);
    await vi.runAllTimersAsync();
    await pending;

    expect(starts).toHaveLength(32);
    for (let index = 1; index < starts.length; index++)
      expect(starts[index] - starts[index - 1]).toBe(61_000);
    expect(report().summary).toMatchObject({
      plannedTurns: 17,
      turns: 17,
      stoppedEarly: false,
      context: { evaluatedTurns: 17, modelDecisions: 16, ruleBypasses: 1 },
      noContext: { evaluatedTurns: 17, modelDecisions: 16, ruleBypasses: 1 },
    });
    expect(process.exitCode).toBe(0);
  });

  it.each([429, 403])(
    'stops on HTTP %s and saves an unequal-arm partial report without inventing results',
    async (statusCode) => {
      evaluate
        .mockResolvedValueOnce(answer)
        .mockResolvedValueOnce(answer)
        .mockRejectedValueOnce(Object.assign(new Error('private provider error'), { statusCode }));

      const pending = runChannelRoutingEval(['--interval-ms', '37000']);
      await vi.runAllTimersAsync();
      await pending;

      expect(evaluate).toHaveBeenCalledTimes(3);
      expect(Date.now()).toBe(1_074_000);
      const result = report();
      expect(result.intervalMs).toBe(37_000);
      expect(result.summary).toMatchObject({
        plannedTurns: 17,
        turns: 2,
        stoppedEarly: true,
        context: { evaluatedTurns: 1, modelDecisions: 1, fallbacks: 0 },
        noContext: { evaluatedTurns: 2, modelDecisions: 1, fallbacks: 1 },
      });
      expect(result.rows[1].results.context).toBeUndefined();
      expect(result.rows[1].results.noContext.diagnostics.errorStatus).toBe(statusCode);
      expect(JSON.stringify(result)).not.toContain('private provider error');
      expect(process.exitCode).toBe(1);
    },
  );

  it('runs the offline baseline without API calls or waiting', async () => {
    await runChannelRoutingEval(['--baseline']);
    expect(evaluate).not.toHaveBeenCalled();
    expect(Date.now()).toBe(1_000_000);
    expect(report().summary).toMatchObject({
      baselineExact: 2,
      jevExecuted: false,
      stoppedEarly: false,
      turns: 17,
    });
  });

  it.each(['-1', 'NaN', '3600001'])(
    'rejects an invalid interval %s before making requests',
    async (interval) => {
      await expect(runChannelRoutingEval(['--interval-ms', interval])).rejects.toThrow(
        '--interval-ms',
      );
      expect(evaluate).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    },
  );
});
