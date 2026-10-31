import type { AgentState } from '@lobechat/agent-runtime';

import {
  AgentOperationModel,
  type AsyncToolResumeIntent,
  listPendingAsyncToolResumes,
} from '@/database/models/agentOperation';
import type { LobeChatDatabase } from '@/database/type';
import { AgentRuntimeCoordinator } from '@/server/modules/AgentRuntime';
import { isHatchetDeliveryEnabled } from '@/server/modules/Hatchet/config';
import { createHatchetDeliveryProbe, type DeliveryProbe } from '@/server/modules/Hatchet/probe';
import { buildTenantCallbackUrl } from '@/server/modules/Tenant/callbackUrl';
import { QueueService } from '@/server/services/queue';

const GRACE_MS = 60_000;
const LEASE_MS = 120_000;
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
/**
 * Bounds one sweep the way the reaper's budget does: a row can cost two
 * delivery probes and a publish. Stopping early is safe, because examined rows
 * move behind the unexamined ones (`lastScannedAt`).
 */
const SWEEP_TIME_BUDGET_MS = 20_000;
/**
 * Re-publishes per intent. An accepted resume can still end FAILED in Hatchet
 * (queued past its schedule timeout, or out of retries), so a parent that still
 * waits with no live delivery is re-sent; one its receiver keeps refusing stops
 * here instead of being re-sent every sweep.
 */
const MAX_REPUBLISH_ATTEMPTS = 3;

export interface AsyncToolResumeSweepResult {
  /** Intents settled because their parent has moved past the handoff. */
  confirmed: number;
  examined: number;
  /** Waiting parents left alone because their re-publish budget is spent. */
  exhausted: number;
  /** Rows whose recovery threw. */
  failed: number;
  republished: number;
}

type RecoveryOutcome = 'confirmed' | 'exhausted' | 'republished';

const classifyState = (state: AgentState, intent: AsyncToolResumeIntent) => {
  if (
    state.stepCount > intent.stepIndex ||
    (state.stepCount === intent.stepIndex &&
      ['running', 'done', 'error', 'interrupted'].includes(state.status))
  )
    return 'advanced';
  if (
    state.status === 'waiting_for_async_tool' &&
    state.stepCount === intent.stepIndex &&
    JSON.stringify((state.pendingToolsCalling ?? []).map((tool) => tool.id).sort()) ===
      JSON.stringify(intent.waitingToolCallIds)
  )
    return 'waiting';
  return 'unknown';
};

/** Recover the parent handoff independently of whether its child bridge was settled. */
export class AsyncToolResumeReconciler {
  private readonly coordinator: AgentRuntimeCoordinator;
  private readonly deliveryProbe: DeliveryProbe;
  private readonly queueService: QueueService;

  constructor(
    private readonly db: LobeChatDatabase,
    options?: {
      coordinator?: AgentRuntimeCoordinator;
      deliveryProbe?: DeliveryProbe;
      queueService?: QueueService;
    },
  ) {
    this.coordinator = options?.coordinator ?? new AgentRuntimeCoordinator();
    this.deliveryProbe = options?.deliveryProbe ?? createHatchetDeliveryProbe();
    this.queueService = options?.queueService ?? new QueueService();
  }

  async sweep(now = new Date()): Promise<AsyncToolResumeSweepResult> {
    const totals: AsyncToolResumeSweepResult = {
      confirmed: 0,
      examined: 0,
      exhausted: 0,
      failed: 0,
      republished: 0,
    };
    if (!isHatchetDeliveryEnabled()) return totals;
    const deadline = Date.now() + SWEEP_TIME_BUDGET_MS;
    let cursor: { scannedAt: string; id: string } | undefined;
    for (let page = 0; page < MAX_PAGES && Date.now() < deadline; page++) {
      const rows = await listPendingAsyncToolResumes(
        this.db,
        new Date(now.getTime() - GRACE_MS),
        now,
        PAGE_SIZE,
        cursor,
      );
      if (!rows.length) break;
      for (const row of rows) {
        if (Date.now() >= deadline) break;
        cursor = { scannedAt: row.scannedAt, id: row.id };
        totals.examined++;
        try {
          await new AgentOperationModel(
            this.db,
            row.userId,
            row.workspaceId ?? undefined,
          ).noteAsyncToolResumeScan(row.id, row.intent.deduplicationId, now);
          const outcome = await this.recover(row);
          if (outcome) totals[outcome]++;
        } catch (error) {
          totals.failed++;
          console.error('[async-tool-resume] recovery failed for %s: %O', row.id, error);
        }
      }
      if (rows.length < PAGE_SIZE) break;
    }
    return totals;
  }

  private async recover(row: {
    createdAt: Date;
    id: string;
    intent: AsyncToolResumeIntent;
    userId: string;
    workspaceId: string | null;
  }): Promise<RecoveryOutcome | undefined> {
    const model = new AgentOperationModel(this.db, row.userId, row.workspaceId ?? undefined);
    const state = await this.coordinator.loadAgentState(row.id);
    if (!state) return;
    const disposition = classifyState(state, row.intent);
    // Only the parent's own progress settles the intent: a publish Hatchet
    // accepted can still end FAILED there and is then re-sent below.
    if (disposition === 'advanced')
      return (await model.confirmAsyncToolResume(row.id, row.intent.deduplicationId))
        ? 'confirmed'
        : undefined;
    if (disposition !== 'waiting') return;
    const checkpoint = { createdAt: row.createdAt, stepCount: row.intent.stepIndex };
    // An accepted run is QUEUED or RUNNING until it ends: no re-send while it lives.
    if ((await this.deliveryProbe(row.id, checkpoint)) !== 'none') {
      await this.coordinator.touchOperation(row.id);
      return;
    }
    const attempts = row.intent.attempts ?? 0;
    if (attempts >= MAX_REPUBLISH_ATTEMPTS) {
      // Identifiers and counts only.
      console.warn(
        JSON.stringify({
          attempts,
          event: 'agent.async_tool_resume.republish_exhausted',
          operationId: row.id,
          stepIndex: row.intent.stepIndex,
        }),
      );
      return 'exhausted';
    }
    const owner = crypto.randomUUID();
    const nextKey = `async-tool-resume:${row.id}:${row.intent.stepIndex}:${crypto.randomUUID()}`;
    const start = new Date();
    if (
      !(await model.claimAsyncToolResume(
        row.id,
        row.intent.deduplicationId,
        nextKey,
        owner,
        start,
        new Date(start.getTime() + LEASE_MS),
        MAX_REPUBLISH_ATTEMPTS,
      ))
    )
      return;
    let leaseLost = false;
    let renewing = Promise.resolve();
    const timer = setInterval(() => {
      renewing = renewing
        .then(async () => {
          const now = new Date();
          if (
            !(await model.renewAsyncToolResume(
              row.id,
              owner,
              now,
              new Date(now.getTime() + LEASE_MS),
            ))
          ) {
            leaseLost = true;
            console.warn('[async-tool-resume] lease lost for %s', row.id);
          }
        })
        .catch((error) => {
          leaseLost = true;
          console.error('[async-tool-resume] lease renewal failed: %O', error);
        });
    }, LEASE_MS / 3);
    try {
      // Recheck after claiming: the old publisher may have reached Hatchet meanwhile.
      if ((await this.deliveryProbe(row.id, checkpoint)) !== 'none') return;
      const latest = await this.coordinator.loadAgentState(row.id);
      if (!latest) return;
      const latestDisposition = classifyState(latest, row.intent);
      if (latestDisposition === 'advanced')
        return (await model.confirmAsyncToolResume(row.id, nextKey)) ? 'confirmed' : undefined;
      if (latestDisposition !== 'waiting') return;
      await this.coordinator.touchOperation(row.id);
      await renewing;
      if (leaseLost) return;
      const baseUrl =
        process.env.AGENT_RUNTIME_BASE_URL || process.env.APP_URL || 'http://localhost:3010';
      await this.queueService.scheduleMessage({
        deduplicationId: nextKey,
        endpoint: `${buildTenantCallbackUrl('/api/agent', baseUrl)}/run`,
        execution: row.intent.execution,
        operationId: row.id,
        payload: row.intent.payload,
        priority: 'high',
        stepIndex: row.intent.stepIndex,
      });
      // Left pending: a later sweep confirms it once the parent advances.
      console.info(
        JSON.stringify({
          attempt: attempts + 1,
          event: 'agent.async_tool_resume.republished',
          operationId: row.id,
          stepIndex: row.intent.stepIndex,
        }),
      );
      return 'republished';
    } finally {
      clearInterval(timer);
      await renewing;
      await model.releaseAsyncToolResume(row.id, owner);
    }
  }
}
