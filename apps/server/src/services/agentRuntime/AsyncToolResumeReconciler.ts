import type { AgentState } from '@lobechat/agent-runtime';

import { AgentOperationModel, type AsyncToolResumeIntent } from '@/database/models/agentOperation';
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

  async sweep(now = new Date()) {
    if (!isHatchetDeliveryEnabled()) return;
    const listing = new AgentOperationModel(this.db, '');
    let cursor: { scannedAt: string; id: string } | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await listing.listPendingAsyncToolResumes(
        new Date(now.getTime() - GRACE_MS),
        now,
        PAGE_SIZE,
        cursor,
      );
      if (!rows.length) break;
      for (const row of rows) {
        cursor = { scannedAt: row.scannedAt, id: row.id };
        try {
          await new AgentOperationModel(
            this.db,
            row.userId,
            row.workspaceId ?? undefined,
          ).noteAsyncToolResumeScan(row.id, row.intent.deduplicationId, now);
          await this.recover(row);
        } catch (error) {
          console.error('[async-tool-resume] recovery failed for %s: %O', row.id, error);
        }
      }
      if (rows.length < PAGE_SIZE) break;
    }
  }

  private async recover(row: {
    createdAt: Date;
    id: string;
    intent: AsyncToolResumeIntent;
    userId: string;
    workspaceId: string | null;
  }) {
    const model = new AgentOperationModel(this.db, row.userId, row.workspaceId ?? undefined);
    const state = await this.coordinator.loadAgentState(row.id);
    if (!state) return;
    const disposition = classifyState(state, row.intent);
    if (disposition === 'advanced') {
      await model.confirmAsyncToolResume(row.id, row.intent.deduplicationId);
      return;
    }
    if (disposition !== 'waiting') return;
    const checkpoint = { createdAt: row.createdAt, stepCount: row.intent.stepIndex };
    if ((await this.deliveryProbe(row.id, checkpoint)) !== 'none') {
      await this.coordinator.touchOperation(row.id);
      return;
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
      if (latestDisposition === 'advanced') {
        await model.confirmAsyncToolResume(row.id, nextKey);
        return;
      }
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
      await model.confirmAsyncToolResume(row.id, nextKey);
    } finally {
      clearInterval(timer);
      await renewing;
      await model.releaseAsyncToolResume(row.id, owner);
    }
  }
}
