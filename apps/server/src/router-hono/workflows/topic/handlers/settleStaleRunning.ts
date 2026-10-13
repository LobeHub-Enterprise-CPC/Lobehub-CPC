import debug from 'debug';
import type { Context } from 'hono';

import { getServerDB } from '@/database/server';
import { StaleRunningTopicSweeper } from '@/server/services/topic/staleRunningTopicSweeper';

const log = debug('lobe-server:workflows:topic:settle-stale-running');

export interface SettleStaleRunningPayload {
  /** Report the candidates and what would be cleared, without writing. */
  dryRun?: boolean;
  /** Cap the rows examined in this tick. */
  limit?: number;
  /** Soft wall-clock budget for this tick, in milliseconds. */
  maxDurationMs?: number;
  /** Override the staleness window, in milliseconds. */
  staleAfterMs?: number;
}

/**
 * Cron-style backstop for topics left `running` by an operation that already
 * ended — see {@link StaleRunningTopicSweeper}.
 *
 * Registered as a QStash Schedule (`*\/10 * * * *`, see
 * `scripts/serverLauncher/startServer.js`) pointing at this endpoint, and
 * signature-verified by the `qstashAuth` middleware on the route. Global scan,
 * no per-user auth: the sweep covers every user's rows, which is the whole point
 * — the leak this repairs is exactly the one whose owner never came back.
 *
 * Every other workflow endpoint follows the same contract, so a deployment that
 * prefers a container cron (`POST /api/workflows/topic/settle-stale-running` with
 * a `dryRun: true` body to start with) can drive it instead of QStash.
 *
 * A tick where every candidate failed is an outage, not a quiet sweep: it
 * answers 5xx so monitoring alerts while the rows stay stuck. A partial failure
 * is one poisoned row among healthy recoveries, so it stays 2xx with
 * `success: false`.
 */
export async function settleStaleRunning(c: Context) {
  const startedAt = Date.now();

  try {
    const body = (await c.req.json().catch(() => ({}))) as SettleStaleRunningPayload;
    const { dryRun = false, limit, maxDurationMs, staleAfterMs } = body ?? {};

    const result = await new StaleRunningTopicSweeper(await getServerDB()).sweep({
      dryRun,
      limit,
      maxDurationMs,
      staleAfterMs,
    });

    log('sweep completed in %dms: %O', Date.now() - startedAt, result);

    if (result.failed > 0)
      console.error('[settle-stale-running] %d candidate(s) failed: %O', result.failed, result);

    const allFailed = result.examined > 0 && result.failed === result.examined;

    return c.json(
      { ...result, executionTime: Date.now() - startedAt, success: result.failed === 0 },
      allFailed ? 500 : 200,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[settle-stale-running] %O', error);

    return c.json({ error: message, executionTime: Date.now() - startedAt, success: false }, 500);
  }
}
