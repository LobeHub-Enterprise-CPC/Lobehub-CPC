import { AgentOperationModel } from '@/database/models/agentOperation';
import { AgentSubAgentBridgeModel } from '@/database/models/agentSubAgentBridge';
import { MessageModel } from '@/database/models/message';
import type { LobeChatDatabase } from '@/database/type';
import { AgentRuntimeCoordinator } from '@/server/modules/AgentRuntime';
import { isHatchetDeliveryEnabled } from '@/server/modules/Hatchet/config';
import { AiAgentService } from '@/server/services/aiAgent';
import { gatewayParentMayResume } from '@/server/services/gatewayAuthorization/parentExecution';

import { validateSubAgentBridge } from './AgentRuntimeService/validateSubAgentBridge';

const PAGE_SIZE = 50;
const MAX_PER_SWEEP = 200;
const GRACE_MS = 60_000;
const WINDOW_MS = 2 * 60 * 60_000;
const LEASE_MS = 120_000;
const TERMINAL = new Set(['done', 'error', 'interrupted', 'abandoned']);

const event = (
  name: 'processed' | 'recovered' | 'failed' | 'skipped',
  reason: string,
  childOperationId: string,
) => {
  const record = JSON.stringify({
    event: `subagent.bridge.reconcile.${name}`,
    reason,
    childOperationId,
  });
  if (name === 'failed') console.warn(record);
  else console.info(record);
};

export class SubAgentBridgeReconciler {
  constructor(private readonly db: LobeChatDatabase) {}

  async sweep(now = new Date()) {
    const totals = { processed: 0, recovered: 0, failed: 0, skipped: 0 };
    if (!isHatchetDeliveryEnabled()) return totals;
    const model = new AgentSubAgentBridgeModel(this.db);
    const coordinator = new AgentRuntimeCoordinator();
    const before = new Date(now.getTime() - GRACE_MS);
    let cursor: { id: string; updatedAt: Date } | undefined;
    while (totals.processed < MAX_PER_SWEEP) {
      const rows = await model.listTerminalRecoverable({
        before,
        cursor,
        limit: Math.min(PAGE_SIZE, MAX_PER_SWEEP - totals.processed),
      });
      if (!rows.length) break;
      for (const { binding, child } of rows) {
        cursor = { id: binding.id, updatedAt: binding.updatedAt };
        totals.processed++;
        event('processed', 'candidate', binding.childOperationId);
        const owner = crypto.randomUUID();
        if (
          !(await model.claim(
            binding.childOperationId,
            owner,
            new Date(),
            new Date(Date.now() + LEASE_MS),
          ))
        ) {
          totals.skipped++;
          event('skipped', 'leased', binding.childOperationId);
          continue;
        }
        // Bridge completion makes network and database calls with no bounded total duration.
        let renewal = Promise.resolve();
        const heartbeat = setInterval(() => {
          renewal = renewal
            .then(async () => {
              const at = new Date();
              if (
                !(await model.renew(
                  binding.childOperationId,
                  owner,
                  at,
                  new Date(at.getTime() + LEASE_MS),
                ))
              )
                event('skipped', 'lease_lost', binding.childOperationId);
            })
            .catch((error) => console.error('[subagent.bridge] lease renewal failed: %O', error));
        }, LEASE_MS / 3);
        try {
          const workspaceId = binding.workspaceId ?? undefined;
          const messageModel = new MessageModel(this.db, binding.userId, workspaceId, undefined, {
            includeShareVisitor: binding.includeShareVisitor,
          });
          const parent = await new AgentOperationModel(
            this.db,
            binding.userId,
            workspaceId,
          ).findById(binding.parentOperationId);
          const params = {
            operationId: binding.childOperationId,
            parentOperationId: binding.parentOperationId,
            threadId: binding.threadId,
            toolMessageId: binding.toolMessageId,
          };
          const validation = await validateSubAgentBridge(
            {
              serverDB: this.db,
              coordinator,
              messageModel,
              userId: binding.userId,
              workspaceId,
              includeShareVisitor: binding.includeShareVisitor,
            },
            params,
          );
          // A CAS winner can write the result and then fail to publish the
          // parent's resume. Intent recovery advances the parent independently,
          // leaving this binding pending. Check the exact batch's backfill
          // before treating a terminal parent (or a later wait) as a failure.
          // Identity/generation rejections must never be accepted as delivery.
          const mayHaveDelivered =
            (validation.allowed && parent && TERMINAL.has(parent.status)) ||
            (!validation.allowed &&
              ['parent_not_waiting', 'tool_not_pending'].includes(validation.reason));
          if (mayHaveDelivered) {
            const message = await messageModel.findById(binding.toolMessageId);
            if (message?.parentId === binding.waitingBatchId && message.content) {
              if (await model.markRecovered(binding.childOperationId, owner, new Date())) {
                totals.recovered++;
                event('recovered', 'already_delivered', binding.childOperationId);
              } else {
                totals.skipped++;
                event('skipped', 'lease_lost', binding.childOperationId);
              }
              continue;
            }
          }
          const expired =
            now.getTime() - (child.completedAt ?? binding.createdAt).getTime() >= WINDOW_MS;
          let failure: string | undefined;
          if (parent && TERMINAL.has(parent.status)) failure = 'parent_terminal';
          else if (
            !validation.allowed &&
            ['ownership_mismatch', 'stale_generation'].includes(validation.reason)
          )
            failure = validation.reason;
          else if (!validation.allowed) {
            const missingState =
              validation.reason === 'tool_not_pending' &&
              parent?.status === 'waiting_for_async_tool' &&
              !(await coordinator.loadAgentState(binding.parentOperationId));
            if (missingState) {
              if (
                !(await gatewayParentMayResume(
                  this.db,
                  binding.childOperationId,
                  binding.parentOperationId,
                  binding.userId,
                ))
              ) {
                failure = 'ownership_mismatch';
              } else {
                const result = await messageModel.updateToolMessage(binding.toolMessageId, {
                  content: 'Sub-agent delivery failed: the parent waiting state is unavailable.',
                  pluginError: { message: 'Parent waiting state is unavailable.' },
                  pluginState: { status: 'error', threadId: binding.threadId },
                  onlyIfEmpty: true,
                });
                if (!result.success) throw new Error('Failed to write missing-state result');
                failure = 'parent_state_missing';
              }
            } else if (expired) failure = 'recovery_window_expired';
            else {
              totals.skipped++;
              event('skipped', validation.reason, binding.childOperationId);
              continue;
            }
          } else {
            const service = new AiAgentService(this.db, binding.userId, {
              workspaceId,
              includeShareVisitor: binding.includeShareVisitor,
            });
            const reason = expired
              ? 'error'
              : child.status === 'done'
                ? 'done'
                : child.status === 'interrupted'
                  ? 'interrupted'
                  : 'error';
            await service.completeSubAgentBridge({
              ...params,
              reason,
              reconcileLeaseOwner: owner,
              ...(expired
                ? { errorMessage: 'Sub-agent delivery exceeded the recovery window.' }
                : {}),
            });
            if (expired) failure = 'recovery_window_expired';
            else if (await model.markRecovered(binding.childOperationId, owner, new Date())) {
              totals.recovered++;
              event('recovered', 'replayed', binding.childOperationId);
            } else {
              totals.skipped++;
              event('skipped', 'lease_lost', binding.childOperationId);
            }
          }
          if (failure) {
            if (await model.markFailed(binding.childOperationId, owner, new Date(), failure)) {
              totals.failed++;
              event('failed', failure, binding.childOperationId);
            } else {
              totals.skipped++;
              event('skipped', 'lease_lost', binding.childOperationId);
            }
          }
        } catch {
          totals.skipped++;
          event('skipped', 'processing_error', binding.childOperationId);
        } finally {
          clearInterval(heartbeat);
          await renewal;
          await model.release(binding.childOperationId, owner);
        }
      }
      if (rows.length < PAGE_SIZE) break;
    }
    return totals;
  }
}
