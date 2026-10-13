import type { AgentOperationStatus, ChatTopicStatus } from '@lobechat/types';
import { isAgentOperationInFlight } from '@lobechat/types';
import debug from 'debug';
import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import { TopicModel } from '@/database/models/topic';
import { agentOperations, topics } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

const log = debug('lobe-server:stale-running-topic-sweeper');

/**
 * How long a topic may keep `status = 'running'` with a `runningOperation` marker
 * that names an already-finished operation before this sweep retires it.
 *
 * Two hours is the same threshold the client-side watchdog
 * (`cleanupStaleRunningTopics`, `STALE_RUNNING_TOPIC_TIMEOUT`) uses, so the two
 * layers agree on what "stale" means and a topic is never retired while a client
 * still considers it live. It is also far longer than any legitimate gap between
 * a run ending and the marker being cleared, which happens in the same
 * transaction as the terminal write on every healthy path.
 */
export const DEFAULT_STALE_RUNNING_TOPIC_MS = 2 * 60 * 60 * 1000;

/**
 * Rows examined per tick. `topics_status_idx` makes the candidate scan cheap,
 * but a stuck deployment can accumulate many rows; the bound keeps one tick short
 * and the next tick picks up where this one stopped (the query is ordered by
 * `updated_at`, and settled rows drop out of it).
 */
export const DEFAULT_STALE_RUNNING_TOPIC_LIMIT = 200;

/**
 * Soft wall-clock budget for one tick. Each row is settled in its own short
 * transaction, so this only bounds how many of those a single tick hands out —
 * the loop stops and the remainder waits for the next tick rather than holding a
 * scheduler delivery open.
 */
export const DEFAULT_MAX_DURATION_MS = 20_000;

export interface SweepStaleRunningTopicsParams {
  /** Report what would be settled without writing anything. */
  dryRun?: boolean;
  limit?: number;
  maxDurationMs?: number;
  /** Override the staleness window, in milliseconds. */
  staleAfterMs?: number;
}

export interface SweepStaleRunningTopicsResult {
  /** Whether the tick stopped early on its time budget; the rest waits a tick. */
  budgetExhausted: boolean;
  /** Candidates proven clearable this tick (0 writes happen when `dryRun`). */
  clearable: number;
  /** Whether the tick wrote anything. */
  dryRun: boolean;
  /** Rows examined this tick — bounded by `limit`. */
  examined: number;
  /** Topics whose settle threw. */
  failed: number;
  /** Markers left in place because their operation is still in flight. */
  live: number;
  /** Topics settled back to a terminal status. */
  settled: number;
  /** Markers another writer had already removed or replaced (nothing to do). */
  skipped: number;
  /** Markers left in place because their operation row could not be found. */
  unknown: number;
}

/** One candidate row: a `running` topic whose marker names an operation. */
interface StaleRunningTopicCandidate {
  id: string;
  operationId: string;
  updatedAt: Date;
  userId: string;
  workspaceId: string | null;
}

/**
 * Map an operation's terminal status onto the topic status a client would have
 * written for the same outcome, so a swept topic reads exactly like one settled
 * by the client or by the server runtime.
 *
 * `done` is the only terminal status whose result the user has not necessarily
 * seen, and `unread` is what the server's own `clearRunningMark` writes for it.
 * Every other terminal status (interrupted / error / abandoned) is a visible
 * interruption the user already saw, which the client settles to `active` and
 * `agentNotify` mirrors for the remote path.
 */
export const topicStatusForTerminalOperation = (
  status: AgentOperationStatus,
): ChatTopicStatus => (status === 'done' ? 'unread' : 'active');

/**
 * Server-side backstop for topics left `running` by an operation that already
 * ended without settling them.
 *
 * Every healthy path clears a topic's `runningOperation` marker through
 * `TopicModel.settleRunningOperation` — the runtime's `finish` executor
 * (`ServerOperationStore.clearRunningMark`), the abandon/reaper paths, and the
 * client on the terminal stream event. All of them are best-effort and none of
 * them is retried: the client's settle is skipped for share visitors (the topic
 * router is owner-scoped) and is a single attempt that a transient server refusal
 * discards, and a run interrupted at a step boundary can reach its terminal
 * `agent_operations` row without the `finish` executor ever running. Nothing then
 * revisits the row, and the only repair left is the CLIENT watchdog
 * (`cleanupStaleRunningTopics`), which needs that user's sidebar open — a topic
 * nobody opens stays `running` forever.
 *
 * Observed 2026-10-13 on a self-hosted deployment: a topic whose marker named an
 * operation that had been `interrupted` three quarters of an hour earlier, whose
 * `updated_at` was frozen at the run's start, and which the UI showed as "running"
 * indefinitely. Sixteen such rows existed, the oldest from two months before —
 * recurring, not an incident.
 *
 * This sweep closes the class rather than one cause: it looks for the shape
 * itself (a `running` topic, longer than the staleness window, whose marker names
 * an operation that has reached a terminal state) and settles it exactly the way
 * the server's own terminal path would.
 *
 * Safety:
 * - **Only provably-finished runs.** The marker's operation row must exist AND
 *   have left every in-flight status. A missing row proves nothing, so the marker
 *   stays.
 * - **Conservative write.** Each row goes through `settleRunningOperation`, which
 *   takes the topic row lock, compares the operation id, and clears only the
 *   marker it matched — so a newer run that claimed the topic after the candidate
 *   query is reported as `conflict` and left alone. Nothing else on the row is
 *   touched, and no message or operation is ever written.
 * - **Bounded.** Candidates are limited per tick and the loop stops on a time
 *   budget; each write is its own short transaction, so no lock is held across
 *   the sweep.
 * - **Idempotent.** A settled row no longer matches the candidate query, and a
 *   re-run against a marker another writer already removed reports `missing`.
 */
export class StaleRunningTopicSweeper {
  constructor(private readonly db: LobeChatDatabase) {}

  async sweep(params?: SweepStaleRunningTopicsParams): Promise<SweepStaleRunningTopicsResult> {
    const dryRun = params?.dryRun ?? false;
    const limit = params?.limit ?? DEFAULT_STALE_RUNNING_TOPIC_LIMIT;
    const maxDurationMs = params?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    const staleAfterMs = params?.staleAfterMs ?? DEFAULT_STALE_RUNNING_TOPIC_MS;
    const startedAt = Date.now();

    const result: SweepStaleRunningTopicsResult = {
      budgetExhausted: false,
      clearable: 0,
      dryRun,
      examined: 0,
      failed: 0,
      live: 0,
      settled: 0,
      skipped: 0,
      unknown: 0,
    };

    const candidates = await this.listCandidates(new Date(Date.now() - staleAfterMs), limit);
    result.examined = candidates.length;
    if (candidates.length === 0) return result;

    const statuses = await this.loadOperationStatuses(candidates.map((c) => c.operationId));

    for (const candidate of candidates) {
      const operationStatus = statuses.get(candidate.operationId);

      // No row at all: nothing here proves the run ended, so the marker stays.
      // (`TopicModel.isRunningOperationAlive` has its own marker-age fallback
      // for rows that were never recorded; this sweep deliberately has none.)
      if (!operationStatus) {
        result.unknown += 1;
        continue;
      }

      if (isAgentOperationInFlight(operationStatus)) {
        result.live += 1;
        continue;
      }

      // Checked before the row is claimed as clearable: a tick that runs out of
      // budget has proven nothing about the rows it never reached.
      if (Date.now() - startedAt >= maxDurationMs) {
        result.budgetExhausted = true;
        break;
      }

      result.clearable += 1;

      if (dryRun) continue;

      try {
        if (await this.settle(candidate, operationStatus)) result.settled += 1;
        else result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        console.error(
          '[stale-running-topic-sweeper] settle failed topic=%s operation=%s: %O',
          candidate.id,
          candidate.operationId,
          error,
        );
      }
    }

    log('sweep: %O', result);

    return result;
  }

  /**
   * `running` topics untouched for longer than the window, each carrying a marker
   * that names an operation.
   *
   * The marker is read with `->>` so a key that is absent and a key that is
   * JSON-null both drop out — a marker with no operation id names nothing this
   * sweep can prove anything about. `topics_status_idx` bounds the scan to the
   * `running` rows, and `order by updated_at` makes successive ticks advance
   * through a backlog instead of re-reading the same head.
   */
  private async listCandidates(staleBefore: Date, limit: number) {
    const markedOperationId = sql<string>`${topics.metadata} -> 'runningOperation' ->> 'operationId'`;

    return this.db
      .select({
        id: topics.id,
        operationId: markedOperationId,
        updatedAt: topics.updatedAt,
        userId: topics.userId,
        workspaceId: topics.workspaceId,
      })
      .from(topics)
      .where(
        and(
          eq(topics.status, 'running'),
          isNotNull(markedOperationId),
          lt(topics.updatedAt, staleBefore),
        ),
      )
      .orderBy(asc(topics.updatedAt))
      .limit(limit);
  }

  /** One indexed lookup on the primary key, batched over the tick's candidates. */
  private async loadOperationStatuses(operationIds: string[]) {
    const ids = [...new Set(operationIds)];

    const rows = await this.db
      .select({ id: agentOperations.id, status: agentOperations.status })
      .from(agentOperations)
      .where(inArray(agentOperations.id, ids));

    return new Map(rows.map((row) => [row.id, row.status as AgentOperationStatus]));
  }

  /**
   * Clear one topic's marker, reusing the same ownership-guarded settle the
   * server's terminal paths use.
   *
   * `includeShareVisitor` matches `ServerOperationStore.clearRunningMark`: a
   * share visitor's topic row is owned by the creator, so the default scope hides
   * it and the settle would silently report `missing` for exactly the rows the
   * visitor paths cannot repair.
   */
  private async settle(
    candidate: StaleRunningTopicCandidate,
    operationStatus: AgentOperationStatus,
  ): Promise<boolean> {
    const topicModel = new TopicModel(
      this.db,
      candidate.userId,
      candidate.workspaceId ?? undefined,
      undefined,
      { includeShareVisitor: true },
    );

    const settled = await topicModel.settleRunningOperation(
      candidate.id,
      candidate.operationId,
      topicStatusForTerminalOperation(operationStatus),
    );

    // `missing` means another writer already removed the marker (or a newer run
    // replaced it and this call lost the race in the other direction) — either
    // way this row is no longer a leak, so it is not a failure.
    if (settled.status !== 'settled') {
      log(
        'skip topic=%s operation=%s: %s',
        candidate.id,
        candidate.operationId,
        settled.status,
      );
    }

    return settled.status === 'settled';
  }
}
