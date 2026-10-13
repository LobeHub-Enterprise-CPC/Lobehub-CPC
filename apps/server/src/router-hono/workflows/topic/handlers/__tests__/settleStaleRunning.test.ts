import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { settleStaleRunning } from '../settleStaleRunning';

const mocks = vi.hoisted(() => ({
  getServerDB: vi.fn(),
  sweep: vi.fn(),
}));

vi.mock('@/database/server', () => ({ getServerDB: mocks.getServerDB }));

vi.mock('@/server/services/topic/staleRunningTopicSweeper', async () => {
  const actual = await vi.importActual<any>('@/server/services/topic/staleRunningTopicSweeper');

  return {
    ...actual,
    StaleRunningTopicSweeper: vi.fn().mockImplementation(function () {
      return { sweep: mocks.sweep };
    }),
  };
});

const emptyResult = {
  budgetExhausted: false,
  clearable: 0,
  dryRun: false,
  examined: 0,
  failed: 0,
  live: 0,
  settled: 0,
  skipped: 0,
  unknown: 0,
};

const call = async (body?: unknown) => {
  const app = new Hono();
  app.post('/settle-stale-running', settleStaleRunning);
  const res = await app.request('/settle-stale-running', {
    body: body === undefined ? undefined : JSON.stringify(body),
    method: 'POST',
  });

  return { body: (await res.json()) as Record<string, any>, status: res.status };
};

describe('settleStaleRunning', () => {
  beforeEach(() => {
    mocks.getServerDB.mockReset().mockResolvedValue({});
    mocks.sweep.mockReset().mockResolvedValue({ ...emptyResult });
  });

  it('runs a real sweep with defaults when the body is empty', async () => {
    const { body, status } = await call();

    expect(status).toBe(200);
    expect(body).toMatchObject({ dryRun: false, success: true });
    expect(mocks.sweep).toHaveBeenCalledWith({
      dryRun: false,
      limit: undefined,
      maxDurationMs: undefined,
      staleAfterMs: undefined,
    });
  });

  it('forwards dryRun and the incident-response overrides', async () => {
    const { status } = await call({
      dryRun: true,
      limit: 5,
      maxDurationMs: 1000,
      staleAfterMs: 60_000,
    });

    expect(status).toBe(200);
    expect(mocks.sweep).toHaveBeenCalledWith({
      dryRun: true,
      limit: 5,
      maxDurationMs: 1000,
      staleAfterMs: 60_000,
    });
  });

  it('reports the sweep counts so a dry run can be read off the response', async () => {
    mocks.sweep.mockResolvedValue({
      ...emptyResult,
      clearable: 16,
      dryRun: true,
      examined: 16,
    });

    const { body, status } = await call({ dryRun: true });

    expect(status).toBe(200);
    expect(body).toMatchObject({ clearable: 16, dryRun: true, examined: 16, success: true });
  });

  it('answers 2xx with success:false on a partial failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.sweep.mockResolvedValue({ ...emptyResult, examined: 3, failed: 1, settled: 2 });

    const { body, status } = await call();

    expect(status).toBe(200);
    expect(body).toMatchObject({ failed: 1, settled: 2, success: false });
    consoleError.mockRestore();
  });

  it('answers 5xx when every candidate failed, so cron monitoring alerts', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.sweep.mockResolvedValue({ ...emptyResult, examined: 2, failed: 2 });

    const { body, status } = await call();

    expect(status).toBe(500);
    expect(body).toMatchObject({ failed: 2, success: false });
    consoleError.mockRestore();
  });

  it('answers 5xx when the sweep itself throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.sweep.mockRejectedValue(new Error('database is down'));

    const { body, status } = await call();

    expect(status).toBe(500);
    expect(body).toMatchObject({ error: 'database is down', success: false });
    consoleError.mockRestore();
  });
});
