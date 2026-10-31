import type { AgentRuntimeContext, AgentState } from '@lobechat/agent-runtime';
import debug from 'debug';
import { and, asc, eq, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import urlJoin from 'url-join';

import { AgentOperationModel } from '@/database/models/agentOperation';
import { agentOperations } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { AgentRuntimeCoordinator } from '@/server/modules/AgentRuntime/AgentRuntimeCoordinator';
import { isHatchetDeliveryEnabled } from '@/server/modules/Hatchet/config';
import type {
  DeliveryCheckpoint,
  DeliveryProbe,
  DeliveryProbeResult,
} from '@/server/modules/Hatchet/probe';
import { buildTenantCallbackUrl } from '@/server/modules/Tenant/callbackUrl';
import { QueueService } from '@/server/services/queue';
import { redisService } from '@/server/services/redis';

import { AbandonOperationService } from './AbandonOperationService';
import { BACKGROUND_OPERATION_TRIGGERS } from './foregroundOperation';
import type { AgentStepContinuation } from './types';

const log = debug('lobe-server:stale-operation-reaper');

/**
 * How long an operation may go without refreshing its durable liveness lease
 * before this sweep treats it as dead.
 *
 * `AgentRuntimeService.startStepLockHeartbeat` touches the row every
 * `STEP_LOCK_HEARTBEAT_MS * DURABLE_LEASE_HEARTBEAT_EVERY_TICKS` = 90s while a
 * step holds the step lock, so five minutes is three missed beats: comfortably
 * past jitter, and far tighter than the 30-minute in-flight window the gateway
 * watchdog has to use (it can only reason about stream events, which stop for
 * legitimately slow first-token latency too).
 */
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
// Two durable lease heartbeats (90s each); the probe protects queued deliveries.
const HATCHET_STALE_AFTER_MS = 3 * 60_000;

/**
 * Redriving costs a real LLM call, so a step that dies deterministically
 * (poison payload, an input that reliably OOMs the host) must not be retried
 * forever. Past this budget the operation is abandoned with a user-visible
 * error instead.
 */
const DEFAULT_MAX_REDRIVE_ATTEMPTS = 3;

/**
 * Bound the work of a single cron tick so one sweep cannot run long: at most
 * this many candidates are acted on, and candidates are read in pages this size.
 */
const DEFAULT_LIMIT = 50;

/**
 * How far one sweep may page past candidates it skips. A skipped candidate
 * (its delivery still queued, say) costs nothing and does not count against
 * the limit, so the oldest rows cannot hide a stranded one behind them; these
 * two budgets keep that walk bounded instead.
 */
const MAX_SWEEP_PAGES = 10;
const SWEEP_TIME_BUDGET_MS = 20_000;

/** Bound how many overlapping topics one sweep reports. */
const CONCURRENT_FOREGROUND_REPORT_LIMIT = 20;

/** Why a candidate was left alone; see `recover`. */
export type StaleSkipReason =
  /** Hatchet still holds a delivery that will run the next step. */
  | 'delivery_active'
  /** Hatchet or the parked envelope could not be read; retried next tick. */
  | 'delivery_unknown'
  | 'no_context'
  | 'no_queue'
  | 'no_state'
  /** Parked or terminal runtime state. */
  | 'not_resumable';

const SKIP_REASONS: readonly StaleSkipReason[] = [
  'delivery_active',
  'delivery_unknown',
  'no_context',
  'no_queue',
  'no_state',
  'not_resumable',
];

const isSkipReason = (outcome: string): outcome is StaleSkipReason =>
  (SKIP_REASONS as readonly string[]).includes(outcome);

export interface ReapStaleOperationsParams {
  limit?: number;
  maxRedriveAttempts?: number;
  staleAfterMs?: number;
}

export interface ReapStaleOperationsResult {
  /** Operations retired with a user-visible error (budget spent, or no context). */
  abandoned: number;
  /** Candidates whose lease was refreshed between select and claim. */
  alive: number;
  /**
   * Topics with two or more foreground runs `running` at once where an older
   * run was never asked to stop. Composer sends supersede the previous run, so
   * such an overlap means a start path slipped past that and both runs are
   * spending on the same conversation. An older run that already carries the
   * interrupt sentinel is only finishing its current step and is not counted.
   * Detection only: nothing is interrupted.
   */
  concurrentForegroundTopics: number;
  examined: number;
  /**
   * Candidates whose recovery threw (Redis, database or queue failure). Reported
   * so a sweep that recovered nothing is visible to whatever polls the endpoint,
   * rather than looking identical to a quiet tick.
   */
  failed: number;
  /** Operations whose next step was re-queued. */
  redriven: number;
  /** Candidates this sweep has no authority over — see `recover`. */
  skipped: number;
  /** `skipped`, by reason. */
  skippedReasons: Record<StaleSkipReason, number>;
}

/** A keyset position: the next page starts strictly after this candidate. */
export interface StaleCursor {
  id: string;
  /**
   * `updated_at` as Postgres text, at full (microsecond) precision. A JS Date
   * would drop the microseconds and make the next page re-read this row.
   */
  updatedAt: string;
}

/**
 * Where the previous sweep stopped, so a sweep cut short by its budgets is
 * continued by the next one instead of starting over at the same oldest rows.
 * Losing it only means starting from the oldest again.
 *
 * If each sweep processes B candidates, a scan takes at most ceil(N / B)
 * intervals plus one sweep's work for N stable candidates, assuming sweeps
 * run on schedule. B is at most MAX_SWEEP_PAGES * limit and can be smaller
 * when the time budget or recovery limit is reached; neither throughput nor
 * scheduling is guaranteed. A cycle over 30 minutes warns well before the
 * 2-hour runtime-state TTL, but cannot guarantee refresh under overload.
 */
export interface StaleSweepCursorStore {
  load: () => Promise<StaleSweepPosition | undefined>;
  /** `undefined` once a sweep reached the newest candidate: the next one wraps around. */
  save: (position: StaleSweepPosition | undefined) => Promise<void>;
}

export interface StaleSweepPosition {
  cursor: StaleCursor;
  cycleStart: number;
}

/** A full scan slower than this risks outliving the runtime-state TTL it refreshes. */
const SLOW_SCAN_CYCLE_MS = 30 * 60_000;
/** `timestamptz::text` in the ISO date style; anything else would fail the cursor's cast. */
const PG_TIMESTAMPTZ_TEXT =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2}){0,2}$/;

const redisSweepCursor: StaleSweepCursorStore = {
  load: async () => {
    const raw = await redisService.staleSweepCursor.load();
    if (!raw) return undefined;
    const { cycleStart, id, updatedAt } = JSON.parse(raw) as Partial<StaleCursor> & {
      cycleStart?: unknown;
    };
    return typeof cycleStart === 'number' &&
      Number.isFinite(cycleStart) &&
      cycleStart >= 0 &&
      typeof id === 'string' &&
      typeof updatedAt === 'string' &&
      PG_TIMESTAMPTZ_TEXT.test(updatedAt)
      ? { cursor: { id, updatedAt }, cycleStart }
      : undefined;
  },
  save: (position) =>
    redisService.staleSweepCursor.save(
      position ? JSON.stringify({ cycleStart: position.cycleStart, ...position.cursor }) : null,
    ),
};

/**
 * Periodic recovery for operations whose executing host died mid-step.
 *
 * A serverless instance can be recycled while it owns a step. When that
 * happens nothing else notices: QStash already ACKed the delivery that started
 * the step (so it never redelivers), the step lock simply expires, and only
 * `services/goal` ever calls `settleStaleRunning` — a chat/bot/task operation
 * has no reaper at all. The row stays `running` forever and the conversation
 * freezes with no error and no way to resume.
 *
 * This sweep closes that hole from the durable side, and prefers *resuming*
 * over reporting: the runtime keeps its resumable state in Redis, so as long
 * as that state is still alive the correct recovery is to re-queue the next
 * step and let the run continue where it stopped. Only when the state is gone
 * (or the redrive budget is spent) does it fall back to abandoning the
 * operation with a visible error the user can retry from.
 *
 * Safety comes from three existing mechanisms rather than new bookkeeping:
 * - `claimStaleRedrive` consumes the candidate in the same UPDATE that selects
 *   it, so overlapping ticks cannot both re-queue one step.
 * - `tryClaimStep` arbitrates against a host that turns out to be alive after
 *   all: the redelivered step loses the lock race and returns without running.
 * - `executeStep` ACKs deliveries for operations already in a terminal state,
 *   so a redrive that races a completion is a no-op.
 *
 * With Hatchet delivery (a `deliveryProbe` is given) a quiet lease is not
 * proof of death: a step can wait in Hatchet (tenant concurrency, retry
 * backoff) well past it. So in that mode the sweep also:
 * - asks Hatchet first, and skips without spending an attempt a candidate whose
 *   next step is still owned there or whose ownership cannot be determined;
 * - refreshes the runtime state of every candidate it skips that way and of
 *   every redrive, because a delivery that keeps waiting for its turn can
 *   outlive the state TTL before any step attempt gets to refresh it;
 * - continues where the previous sweep stopped (`sweepCursor`), so a backlog
 *   of skipped candidates larger than one sweep's budget cannot keep hiding
 *   the newer ones.
 */
export class StaleOperationReaper {
  private readonly coordinator: AgentRuntimeCoordinator;
  private readonly deliveryProbe?: DeliveryProbe;
  private readonly queueService: QueueService | null;
  private readonly sweepCursor?: StaleSweepCursorStore;

  constructor(
    private readonly db: LobeChatDatabase,
    options?: {
      coordinator?: AgentRuntimeCoordinator;
      deliveryProbe?: DeliveryProbe;
      queueService?: QueueService | null;
      /** Defaults to a Redis key when `deliveryProbe` is given; none otherwise. */
      sweepCursor?: StaleSweepCursorStore;
    },
  ) {
    this.coordinator = options?.coordinator ?? new AgentRuntimeCoordinator();
    this.deliveryProbe = options?.deliveryProbe;
    this.queueService =
      options?.queueService === null ? null : (options?.queueService ?? new QueueService());
    this.sweepCursor =
      options?.sweepCursor ?? (options?.deliveryProbe ? redisSweepCursor : undefined);
  }

  private get baseURL() {
    const baseUrl = process.env.AGENT_RUNTIME_BASE_URL || process.env.APP_URL;

    // A redriven step runs in the tenant that owns the operation.
    return buildTenantCallbackUrl('/api/agent', baseUrl || 'http://localhost:3010');
  }

  async sweep(params?: ReapStaleOperationsParams): Promise<ReapStaleOperationsResult> {
    const staleAfterMs =
      params?.staleAfterMs ??
      (isHatchetDeliveryEnabled() ? HATCHET_STALE_AFTER_MS : DEFAULT_STALE_AFTER_MS);
    const maxRedriveAttempts = params?.maxRedriveAttempts ?? DEFAULT_MAX_REDRIVE_ATTEMPTS;
    const limit = params?.limit ?? DEFAULT_LIMIT;
    const staleBefore = new Date(Date.now() - staleAfterMs);
    const deadline = Date.now() + SWEEP_TIME_BUDGET_MS;

    const result: ReapStaleOperationsResult = {
      abandoned: 0,
      alive: 0,
      concurrentForegroundTopics: 0,
      examined: 0,
      failed: 0,
      redriven: 0,
      skipped: 0,
      skippedReasons: Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<
        StaleSkipReason,
        number
      >,
    };

    const position = await this.sweepCursor?.load().catch((e) => {
      log('sweep cursor unreadable, starting from the oldest: %O', e);
      return undefined;
    });

    // A sweep that starts from the oldest starts a new full scan. A lost
    // cursor restarts the scan too (only the alarm for the cut-short one is
    // lost); reaching the newest below closes it.
    const cycleStart = position?.cycleStart ?? Date.now();
    const resumedFrom = position?.cursor;

    // Everything but a skip counts against `limit`; skips page on instead.
    let acted = 0;
    let cursor = resumedFrom;
    let lastExamined: StaleCursor | undefined;
    let reachedEnd = false;
    for (
      let page = 0;
      page < (this.deliveryProbe ? MAX_SWEEP_PAGES : 1) && acted < limit && Date.now() < deadline;
      page += 1
    ) {
      const candidates = await this.listStaleRunning(staleBefore, limit, cursor);

      let cutShort = false;
      for (const candidate of candidates) {
        if (acted >= limit || Date.now() >= deadline) {
          cutShort = true;
          break;
        }
        lastExamined = { id: candidate.id, updatedAt: candidate.updatedAt };
        result.examined += 1;
        try {
          const outcome = await this.recover(candidate, staleBefore, maxRedriveAttempts);
          if (isSkipReason(outcome)) {
            result.skipped += 1;
            result.skippedReasons[outcome] += 1;
          } else {
            result[outcome] += 1;
            acted += 1;
          }
        } catch (e) {
          // One poisoned row must not abort the rest of the sweep.
          result.failed += 1;
          acted += 1;
          log('[%s] recovery failed: %O', candidate.id, e);
        }
      }

      if (cutShort) break;
      if (candidates.length < limit) {
        reachedEnd = true;
        break;
      }
      cursor = candidates.at(-1);
    }

    const nextCursor = lastExamined ?? resumedFrom;
    await this.sweepCursor
      ?.save(!reachedEnd && nextCursor ? { cursor: nextCursor, cycleStart } : undefined)
      .catch((e) => log('sweep cursor not saved: %O', e));

    // Closing a full scan: warn while the 2h state TTL still has headroom if
    // the scan outgrew it, then open the next scan. Identifiers and timings
    // only: never message contents.
    if (reachedEnd && this.sweepCursor) {
      const elapsedMs = Date.now() - cycleStart;
      if (elapsedMs > SLOW_SCAN_CYCLE_MS)
        console.warn(
          JSON.stringify({
            elapsedMs,
            event: 'agent.reaper.scan_cycle_slow',
            examined: result.examined,
          }),
        );
    }

    try {
      result.concurrentForegroundTopics = await this.reportConcurrentForegroundRuns();
    } catch (e) {
      log('concurrent foreground patrol failed: %O', e);
    }

    log('sweep done: %O', result);
    return result;
  }

  /**
   * Warn about topics where more than one foreground run is live. Top-level
   * runs only: sub-agent children (`parentOperationId`) and thread runs
   * (`threadId`) legitimately run beside the topic's main run.
   */
  private async reportConcurrentForegroundRuns(): Promise<number> {
    const rows = await this.db
      .select({
        operationIds: sql<
          string[]
        >`array_agg(${agentOperations.id} order by ${agentOperations.createdAt})`,
        topicId: agentOperations.topicId,
      })
      .from(agentOperations)
      .where(
        and(
          eq(agentOperations.status, 'running'),
          isNotNull(agentOperations.topicId),
          isNull(agentOperations.threadId),
          isNull(agentOperations.parentOperationId),
          or(
            isNull(agentOperations.trigger),
            notInArray(agentOperations.trigger, [...BACKGROUND_OPERATION_TRIGGERS]),
          ),
        ),
      )
      .groupBy(agentOperations.topicId)
      .having(sql`count(*) > 1`)
      .limit(CONCURRENT_FOREGROUND_REPORT_LIMIT);

    let reported = 0;
    for (const row of rows) {
      // The newest run is the one that should survive; an older run with the
      // sentinel set was stopped (Stop / Send now / supersede) and exits at its
      // next step boundary, which can be minutes into a long LLM call.
      const older = row.operationIds.slice(0, -1);
      const interrupted = await Promise.all(older.map((id) => this.coordinator.isInterrupted(id)));
      const unstopped = older.filter((_, index) => !interrupted[index]);
      if (unstopped.length === 0) continue;

      reported += 1;
      console.warn('[StaleOperationReaper] concurrent foreground operations on one topic', {
        ...row,
        unstoppedOperationIds: unstopped,
      });
    }

    return reported;
  }

  /**
   * Stale candidates across all tenants. Queried directly rather than through
   * `AgentOperationModel`, which is user-scoped by construction — this is a
   * system-level sweep, and the per-operation mutations below re-enter the
   * model with the row's own owner so ownership is still enforced where it
   * matters.
   */
  private async listStaleRunning(staleBefore: Date, limit: number, after?: StaleCursor) {
    return (
      this.db
        // Only what recovery needs: everything else about the run is read from
        // the coordinator state, and the abandon path re-reads the row itself.
        .select({
          createdAt: agentOperations.createdAt,
          id: agentOperations.id,
          updatedAt: sql<string>`${agentOperations.updatedAt}::text`,
          userId: agentOperations.userId,
          workspaceId: agentOperations.workspaceId,
        })
        .from(agentOperations)
        .where(
          and(
            eq(agentOperations.status, 'running'),
            lt(agentOperations.updatedAt, staleBefore),
            // A never-heartbeated row is only meaningful once it is older than
            // the window too; `startedAt` is the lease's initial value.
            or(isNull(agentOperations.startedAt), lt(agentOperations.startedAt, staleBefore)),
            after
              ? sql`(${agentOperations.updatedAt}, ${agentOperations.id}) > (${after.updatedAt}::timestamptz, ${after.id}::text)`
              : undefined,
          ),
        )
        // Oldest first: a backlog should drain in the order it accumulated.
        // `id` breaks ties so the keyset above neither skips nor repeats rows.
        .orderBy(asc(agentOperations.updatedAt), asc(agentOperations.id))
        .limit(limit)
    );
  }

  private async recover(
    candidate: { createdAt?: Date; id: string; userId: string; workspaceId: string | null },
    staleBefore: Date,
    maxRedriveAttempts: number,
  ): Promise<'abandoned' | 'alive' | 'redriven' | StaleSkipReason> {
    const operationId = candidate.id;
    const operationModel = new AgentOperationModel(
      this.db,
      candidate.userId,
      candidate.workspaceId ?? undefined,
    );

    // Everything that decides *whether* to act is read before the claim, so a
    // candidate this sweep cannot help never consumes an attempt.
    const state = await this.coordinator.loadAgentState(operationId).catch((e) => {
      log('[%s] state load failed, treating as unresumable: %O', operationId, e);
      return null;
    });

    // No coordinator state means this sweep has no authority over the run.
    // Crucially that is the shape of a *healthy* heterogeneous operation: a
    // Claude Code / Codex run is driven by an external CLI, never creates
    // coordinator state, and only refreshes its lease when `heteroIngest`
    // batches arrive — so a single long tool call reads as "stale" here.
    // Retiring one would be actively destructive rather than merely useless:
    // `heteroIngest` bails out on `touchRunning` returning false, so every
    // subsequent batch of a live session would be dropped before persistence.
    //
    // Stateless-but-genuinely-dead operations are the inactivity watchdog's
    // job (it reaches them through `finalize-abandoned`), and it has the
    // gateway-side evidence to tell the two apart. This sweep deliberately
    // limits itself to runs it can actually resume.
    if (!state) return 'no_state';
    if (!this.queueService) return 'no_queue';

    // Parked operations have their own resume paths; a plain step would run
    // past whatever they are waiting on.
    if (!this.canRedrive(state)) return 'not_resumable';

    // `stepCount` is the number of completed steps, so it is also the index of
    // the step that never finished.
    const stepIndex = state.stepCount;

    if (this.deliveryProbe) {
      const delivery = await this.probeDelivery(this.deliveryProbe, operationId, {
        createdAt: candidate.createdAt,
        stepCount: stepIndex,
      });
      if (delivery !== 'none') {
        // Waiting is legitimate, but it is not refreshing the state: keep it
        // for as long as this sweep is the one looking after the operation.
        await this.keepRecoverable(operationId);
        log('[%s][%d] next step delivery is %s', operationId, stepIndex, delivery);
        return delivery === 'active' ? 'delivery_active' : 'delivery_unknown';
      }
    }

    // The context is NOT optional in practice. `runtime.step` falls back to
    // `createInitialContext(state)` when it gets none, which re-enters the run
    // at `user_input` — so a step that owed a `tool_result` / graph
    // continuation would instead start a fresh LLM turn and silently drop the
    // pending work. Recover the real one, and refuse to redrive without it:
    // abandoning with a visible error is recoverable, corrupting the run is
    // not.
    const context = await this.resolveRedriveContext(operationId, state, stepIndex);
    if (!context) {
      // Skipped rather than abandoned, because "no context" is not a reliable
      // signal: `AgentStateManager.getExecutionHistory` swallows a failed
      // LRANGE or a JSON parse error and returns an empty array, so a
      // transient Redis blip is indistinguishable here from a genuinely
      // missing entry. Retiring an operation is irreversible and user-visible,
      // and this one is otherwise resumable — a later tick may well recover it
      // once the read succeeds, and the inactivity watchdog still declares it
      // dead if it never does.
      log('[%s][%d] no persisted context to resume from', operationId, stepIndex);
      return 'no_context';
    }

    const attempt = await operationModel.claimStaleRedrive(
      operationId,
      staleBefore,
      maxRedriveAttempts,
    );

    if (attempt === null) {
      // Either a heartbeat landed while we were reading state (the step is
      // alive and owns itself again) or the redrive budget is spent. The CAS
      // below distinguishes them without a separate read: only a row that is
      // still both running and past its lease can be retired.
      return this.abandonIfStillStale(
        operationModel,
        operationId,
        staleBefore,
        'redrive_exhausted',
      );
    }

    // The redrive can queue in Hatchet as long as any delivery before it runs.
    if (this.deliveryProbe) await this.keepRecoverable(operationId);

    try {
      await this.queueService.scheduleMessage({
        context,
        // Distinct per attempt: a shared key would let the provider dedupe a
        // genuinely needed second redrive away and strand the operation again.
        deduplicationId: `stale-redrive:${operationId}:${stepIndex}:${attempt}`,
        endpoint: urlJoin(this.baseURL, '/run'),
        operationId,
        priority: 'normal',
        retryDelay:
          typeof state.metadata?.queueRetryDelay === 'string'
            ? state.metadata.queueRetryDelay
            : undefined,
        retries:
          typeof state.metadata?.queueRetries === 'number'
            ? state.metadata.queueRetries
            : undefined,
        stepIndex,
      });
    } catch (e) {
      // The attempt was claimed before publishing, because the claim is also
      // the mutual exclusion between overlapping sweeps. Publishing is what it
      // was claimed *for*, so a failure has to give it back — the budget
      // bounds LLM spend, and nothing was spent. Without this, a brief queue
      // outage walks a healthy operation to its limit and retires it having
      // never attempted a single recovery.
      await operationModel.releaseStaleRedrive(operationId, attempt).catch((releaseError) => {
        log('[%s] failed to release redrive attempt %d: %O', operationId, attempt, releaseError);
      });
      throw e;
    }

    log('[%s][%d] redriven (attempt %d/%d)', operationId, stepIndex, attempt, maxRedriveAttempts);
    return 'redriven';
  }

  /**
   * Ask the delivery layer whether the next step is still owned there. The
   * parked inline envelope is part of the checkpoint because a plain step
   * delivery for an older index resumes from it. Anything that cannot be read
   * is `unknown` and warned about: the candidate stays as it is until it can.
   */
  private async probeDelivery(
    probe: DeliveryProbe,
    operationId: string,
    { createdAt, stepCount }: Omit<DeliveryCheckpoint, 'envelopeStepIndex'>,
  ): Promise<DeliveryProbeResult> {
    // Identifiers and step indexes only: never the envelope or any message body.
    const warnUnknown = (detail: { envelopeStepIndex?: number; source: string }) =>
      console.warn(
        JSON.stringify({
          event: 'agent.reaper.delivery_probe_unknown',
          operationId,
          stepCount,
          ...detail,
        }),
      );

    let envelopeStepIndex: number | undefined;
    try {
      const envelope = await this.coordinator.loadInlineResume<AgentStepContinuation>(operationId);
      if (typeof envelope?.stepIndex === 'number') envelopeStepIndex = envelope.stepIndex;
    } catch {
      warnUnknown({ source: 'envelope' });
      return 'unknown';
    }

    const delivery = await probe(operationId, { createdAt, envelopeStepIndex, stepCount }).catch(
      (e): DeliveryProbeResult => {
        log('[%s] delivery probe threw: %O', operationId, e);
        return 'unknown';
      },
    );
    if (delivery === 'unknown') warnUnknown({ envelopeStepIndex, source: 'probe' });
    return delivery;
  }

  /**
   * Re-arm the TTL of the operation's runtime keys. Best effort: a failed
   * refresh leaves the state exactly as it was, and the next sweep tries again.
   */
  private async keepRecoverable(operationId: string): Promise<void> {
    await this.coordinator.touchOperation(operationId).catch((e) => {
      log('[%s] runtime state refresh failed: %O', operationId, e);
    });
  }

  /**
   * The context the interrupted step should have received.
   *
   * Step 0 carries the context the operation was created with, which the
   * runtime persists onto the state — the same field the intervention
   * continuation re-publishes from. Every later step is driven by the
   * `nextContext` its predecessor produced, which `saveStepResult` stores
   * alongside the step in the execution history under the *producing* step's
   * index (so step N's entry holds the context for step N+1).
   *
   * Returns undefined rather than a synthesized fallback: the caller must be
   * able to tell "resume correctly" from "cannot resume".
   */
  private async resolveRedriveContext(
    operationId: string,
    state: AgentState,
    stepIndex: number,
  ): Promise<AgentRuntimeContext | undefined> {
    if (stepIndex === 0) {
      return (state as AgentState & { initialContext?: AgentRuntimeContext }).initialContext;
    }

    try {
      const history = await this.coordinator.getExecutionHistory(operationId);
      const producer = history.find(
        (entry: { context?: AgentRuntimeContext; stepIndex?: number }) =>
          entry?.stepIndex === stepIndex - 1,
      );

      return producer?.context;
    } catch (e) {
      log('[%s][%d] execution history lookup failed: %O', operationId, stepIndex, e);
      return undefined;
    }
  }

  /**
   * Whether the runtime state can still carry a resumed step.
   *
   * `idle` counts alongside `running`: it is the status a state carries
   * between its creation and the first step, which is exactly the shape of an
   * operation whose step-0 delivery never executed (the row is `running` with
   * no steps, no snapshot and no messages beyond the user turn). Those are
   * resumable for the same reason a mid-run death is — the state describes a
   * step that still needs to happen.
   *
   * Parked operations are excluded on purpose: `waiting_for_human` and
   * `waiting_for_async_tool` are deliberate pauses with their own resume
   * paths, and re-queueing a plain step would run past the thing they wait on.
   * Terminal statuses are excluded because there is nothing left to run.
   */
  private canRedrive(state: AgentState | null): state is AgentState {
    return (
      !!state &&
      (state.status === 'running' || state.status === 'idle') &&
      typeof state.stepCount === 'number' &&
      state.stepCount >= 0
    );
  }

  /**
   * Retire an operation, but only if it is *still* past its lease at this
   * instant.
   *
   * Abandonment is irreversible and user-visible — it settles the durable row,
   * errors the conversation tail and clears the topic's running pointer — so it
   * must never act on a stale read. Minutes can pass between
   * `listStaleRunning` selecting a candidate and this line running (the sweep
   * walks candidates serially, and reading state plus execution history costs
   * two Redis round trips each), which is ample room for the worker to resume
   * and heartbeat. A transiently empty history read reaches here the same way.
   *
   * `settleStaleRunning` is the compare-and-set that closes it: its WHERE
   * clause re-checks `status = 'running' AND updatedAt < staleBefore` inside
   * the UPDATE, so a heartbeat that landed in the meantime wins and this
   * returns `alive` untouched. Only once the row is claimed do the
   * irreversible side effects run.
   */
  private async abandonIfStillStale(
    operationModel: AgentOperationModel,
    operationId: string,
    staleBefore: Date,
    reason: string,
  ): Promise<'abandoned' | 'alive'> {
    const claimed = await operationModel.settleStaleRunning(operationId, staleBefore);
    if (!claimed) {
      log('[%s] lease was refreshed before abandon could claim it', operationId);
      return 'alive';
    }

    // The claim above already moved the row to `abandoned`; tell the lifecycle
    // so it persists onto that status instead of being refused as a conflicting
    // terminal owner — which would skip `onComplete` / `onError` and leave
    // hook consumers (tasks, bots, parent runs) waiting on a retired operation.
    await new AbandonOperationService(this.db).finalizeAbandoned(
      operationId,
      `stale_lease_${reason}`,
      { settledAsAbandoned: true },
    );
    log('[%s] abandoned (reason=%s)', operationId, reason);

    return 'abandoned';
  }
}
