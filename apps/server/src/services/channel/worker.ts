import type { ChannelMemberConfig } from '@lobechat/types';
import { and, asc, eq, isNull, or } from 'drizzle-orm';

import { ChannelModel } from '@/database/models/channel';
import { ChannelRuntimeModel } from '@/database/models/channelRuntime';
import {
  channelJobs,
  channelMembers,
  channelMessages,
  channelRuns,
  channels,
} from '@/database/schemas/channel';
import type { LobeChatDatabase } from '@/database/type';

import { waitForChannelApproval } from './approval';
import { channelArtifactCapability, saveChannelArtifact } from './artifact';
import { ChannelDevice } from './device';
import { isChannelEnabled } from './gate';
import { loadChannelNativeCapabilities } from './native/capabilities';
import type { ChannelNativeCapabilities } from './native/host';
import { isChannelApprovalCheckpoint, runChannelNative } from './native/host';
import { routeChannelMessage } from './router';

/** Durable database queue consumer. No execution is tied to a browser or HTTP request. */
export class ChannelWorker {
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private ticking = false;
  private readonly publicationFences = new Map<string, number>();

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly capabilities = loadChannelNativeCapabilities,
  ) {}

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const active = await this.db
        .select({
          run: channelRuns,
          channel: channels,
          config: channelMembers.config,
          memberActive: channelMembers.active,
        })
        .from(channelRuns)
        .innerJoin(channels, eq(channels.id, channelRuns.channelId))
        .innerJoin(channelMembers, eq(channelMembers.id, channelRuns.memberId))
        .where(
          or(
            eq(channelRuns.writerReleased, false),
            and(isNull(channelRuns.publishedMessageId), eq(channelRuns.publicationRevoked, false)),
          ),
        );
      for (const entry of active) {
        const { run, channel, config, memberActive } = entry;
        const model = new ChannelModel(this.db, channel.ownerId);
        if (!isChannelEnabled(channel.ownerId) || channel.archived || !memberActive)
          await model.stop(channel.id, { runId: run.id });
        const stopped =
          run.publicationRevoked ||
          !isChannelEnabled(channel.ownerId) ||
          channel.archived ||
          !memberActive;
        if (stopped) this.active.get(run.id)?.abort.abort();
        if (run.writerReleased && run.draft !== null && !run.publishedMessageId && !stopped) {
          try {
            const fence =
              this.publicationFences.get(run.id) === run.fence
                ? run.fence
                : await model.recoverDraft(channel.id, run.id, run.fence);
            this.publicationFences.set(run.id, fence);
            await model.publish(channel.id, run.id, fence);
            this.publicationFences.delete(run.id);
          } catch {
            /* The saved draft remains available to the next publisher. */
          }
          continue;
        }
        if (config.runtime !== 'native' && config.deviceId) {
          try {
            await this.reconcileCodex(model, channel.ownerId, run, config, stopped);
          } catch (error) {
            await model.executionUnknown(channel.id, run.id, run.fence, String(error));
          }
        } else if (run.draft && !stopped) {
          await model.publish(channel.id, run.id, run.fence).catch(() => {});
        } else if (!this.active.has(run.id) && !run.writerReleased) {
          const { checkpoint } = await new ChannelRuntimeModel(
            this.db,
            channel.ownerId,
            run.id,
            run.fence,
          ).load();
          if (isChannelApprovalCheckpoint(checkpoint, run.id)) {
            if (stopped) await model.releaseWriter(channel.id, run.id, run.fence);
            else {
              try {
                const capabilities = await this.capabilities(this.db, channel.ownerId, config);
                await this.startNative(model, channel.ownerId, run, config, capabilities);
              } catch (error) {
                await model.fail(channel.id, run.id, run.fence, String(error));
                await model.releaseWriter(channel.id, run.id, run.fence);
              }
            }
          } else {
            // An in-flight tool cannot be replayed or declared terminated by a new worker.
            await model.executionUnknown(
              channel.id,
              run.id,
              run.fence,
              'Native worker disconnected; execution requires inspection',
            );
          }
        }
      }
      const pending = await this.db
        .select({ message: channelMessages, ownerId: channels.ownerId })
        .from(channelMessages)
        .innerJoin(channels, eq(channels.id, channelMessages.channelId))
        .where(and(eq(channelMessages.routingStatus, 'pending'), eq(channels.archived, false)))
        .orderBy(asc(channelMessages.createdAt))
        .limit(20);
      await Promise.allSettled(
        pending
          .filter((item) => isChannelEnabled(item.ownerId))
          .map(({ message, ownerId }) =>
            routeChannelMessage(
              this.db,
              ownerId,
              new ChannelModel(this.db, ownerId),
              message.channelId,
              message.id,
            ),
          ),
      );
      const jobs = await this.db
        .select({ job: channelJobs, channel: channels, config: channelMembers.config })
        .from(channelJobs)
        .innerJoin(channels, eq(channels.id, channelJobs.channelId))
        .innerJoin(channelMembers, eq(channelMembers.id, channelJobs.memberId))
        .where(
          and(
            eq(channelJobs.status, 'queued'),
            eq(channels.archived, false),
            eq(channelMembers.active, true),
          ),
        )
        .orderBy(asc(channelJobs.createdAt))
        .limit(40);
      await Promise.allSettled(
        jobs.map(async ({ job, channel, config }) => {
          if (!isChannelEnabled(channel.ownerId)) return;
          const model = new ChannelModel(this.db, channel.ownerId);
          let capabilities: ChannelNativeCapabilities | undefined;
          try {
            if (config.deviceId && config.workingDirectory) {
              const canonical = await new ChannelDevice(
                this.db,
                channel.ownerId,
                config.deviceId,
              ).probe(config.workingDirectory, config.runtime);
              if (canonical !== config.workingDirectory) return;
            }
            if (config.runtime === 'native')
              capabilities = await this.capabilities(this.db, channel.ownerId, config);
          } catch (error) {
            await model.unavailable(
              channel.id,
              job.id,
              error instanceof Error ? error.message : String(error),
            );
            return; /* Unavailable before submission: leave the durable job queued. */
          }
          // Clear a previous availability failure even if the shared workspace is still busy.
          await model.unavailable(channel.id, job.id, null);
          const claim = await model.claim(channel.id, job.id);
          if (!claim) return;
          if (config.runtime === 'native') {
            try {
              await this.startNative(model, channel.ownerId, claim.run, config, capabilities!);
            } catch (error) {
              await model.fail(channel.id, claim.run.id, claim.run.fence, String(error));
              await model.releaseWriter(channel.id, claim.run.id, claim.run.fence);
            }
          } else if (config.deviceId && config.workingDirectory) {
            try {
              await new ChannelDevice(this.db, channel.ownerId, config.deviceId).start({
                cwd: config.workingDirectory,
                fence: claim.run.fence,
                manifest: claim.run.manifest,
                model: config.model,
                runtime: config.runtime,
                systemRole: config.systemRole,
                runId: claim.run.id,
                sessionId: claim.session.nativeSessionId,
              });
            } catch {
              /* Ambiguous acceptance: inspect on the next tick, never resend. */
            }
          }
        }),
      );
    } finally {
      this.ticking = false;
    }
  }

  private async startNative(
    model: ChannelModel,
    ownerId: string,
    run: typeof channelRuns.$inferSelect,
    config: ChannelMemberConfig,
    original: ChannelNativeCapabilities,
  ) {
    const artifact = await channelArtifactCapability(this.db, ownerId, run);
    const capabilities = {
      ...original,
      tools: [...original.tools, ...artifact.tools],
      toolManifestMap: { ...original.toolManifestMap, ...artifact.toolManifestMap },
      toolTransport: {
        maxRetries: 0,
        run: ((call, context) =>
          call.identifier === 'channel-artifact'
            ? artifact.toolTransport!.run(call, context)
            : original.toolTransport!.run(call, context)) as NonNullable<
          ChannelNativeCapabilities['toolTransport']
        >['run'],
      },
    };
    const abort = new AbortController();
    const done = this.native(model, ownerId, run, config, capabilities, abort).finally(() =>
      this.active.delete(run.id),
    );
    this.active.set(run.id, { abort, done });
  }

  private async native(
    model: ChannelModel,
    ownerId: string,
    run: typeof channelRuns.$inferSelect,
    config: ChannelMemberConfig,
    capabilities: ChannelNativeCapabilities,
    abort: AbortController,
  ) {
    const pendingTools = new Set<Promise<unknown>>();
    let toolsConfirmed = true;
    let draftSaved = false;
    const toolTransport = capabilities.toolTransport;
    try {
      const result = await runChannelNative({
        db: this.db,
        ownerId,
        runId: run.id,
        fence: run.fence,
        config,
        signal: abort.signal,
        onAccepted: (sessionId, turnId) =>
          model.accepted(run.channelId, run.id, run.fence, sessionId, turnId),
        onActivity: (state) => model.setActivity(run.channelId, run.id, run.fence, state),
        onApproval: (tool) =>
          waitForChannelApproval({
            channelId: run.channelId,
            runId: run.id,
            fence: run.fence,
            model,
            signal: abort.signal,
            tool,
          }),
        capabilities: {
          ...capabilities,
          toolTransport: toolTransport && {
            ...toolTransport,
            run: (...args) => {
              const pending = toolTransport.run(...args);
              pendingTools.add(pending);
              void pending
                .then(
                  (result) => {
                    if (!result.result.success) toolsConfirmed = false;
                  },
                  () => {
                    toolsConfirmed = false;
                  },
                )
                .finally(() => pendingTools.delete(pending));
              return pending;
            },
          },
        },
      });
      if (result.content && !abort.signal.aborted) {
        await model.recordExecution(run.channelId, run.id, run.fence, {
          runtime: 'native',
          model: config.model,
          provider: config.provider,
          ...result.budget,
        });
        await model.saveDraft(run.channelId, run.id, run.fence, result.content);
        draftSaved = true;
        await model.publish(run.channelId, run.id, run.fence);
      }
    } catch (error) {
      if (!draftSaved)
        await model.fail(
          run.channelId,
          run.id,
          run.fence,
          error instanceof Error ? error.message : String(error),
          false,
        );
    } finally {
      // AgentRuntime can settle its abort race before its tool promise has settled.
      await Promise.allSettled(pendingTools);
      if (toolsConfirmed) await model.releaseWriter(run.channelId, run.id, run.fence);
      else
        await model.fail(
          run.channelId,
          run.id,
          run.fence,
          'Tool execution ended without physical confirmation',
          true,
        );
    }
  }

  private async reconcileCodex(
    model: ChannelModel,
    ownerId: string,
    run: typeof channelRuns.$inferSelect,
    config: ChannelMemberConfig,
    stopped: boolean,
  ) {
    const device = new ChannelDevice(this.db, ownerId, config.deviceId!);
    const snapshot = stopped
      ? await device.stop(run.id, run.fence)
      : await device.inspect(run.id, run.fence);
    if (!snapshot) {
      await model.executionUnknown(
        run.channelId,
        run.id,
        run.fence,
        'Device has no receipt; this Run will not be resubmitted',
      );
      return;
    }
    if (snapshot.fence !== run.fence || snapshot.runId !== run.id)
      throw new Error('Stale device receipt');
    if (!stopped && snapshot.status === 'running')
      await model.setActivity(run.channelId, run.id, run.fence, snapshot.activity || 'running');
    if (!stopped && snapshot.acceptance === 'accepted' && snapshot.sessionId && snapshot.turnId)
      await model.accepted(run.channelId, run.id, run.fence, snapshot.sessionId, snapshot.turnId);
    if (!stopped && snapshot.approval) {
      const approval = await model.requestApproval(
        run.channelId,
        run.id,
        run.fence,
        `${run.id}:${snapshot.approval.id}`,
        { method: snapshot.approval.method, request: snapshot.approval.request },
        new Date(snapshot.approval.expiresAt),
      );
      if (approval.decision)
        await device.approve(
          run.id,
          run.fence,
          snapshot.approval.id,
          approval.decision === 'approved',
        );
    }
    if (
      !stopped &&
      snapshot.status === 'completed' &&
      snapshot.content &&
      snapshot.physicalStopped
    ) {
      if (!snapshot.evidence?.final) return; // Older Desktop may expose termination while its snapshot is still being captured.
      await model.recordExecution(run.channelId, run.id, run.fence, {
        runtime: config.runtime,
        model: config.model,
        modelCalls: snapshot.modelCalls,
        toolCalls: snapshot.toolCalls,
      });
      await saveChannelArtifact(this.db, ownerId, run.channelId, run.id, snapshot);
      await model.saveDraft(run.channelId, run.id, run.fence, snapshot.content);
      await model.publish(run.channelId, run.id, run.fence);
    }
    if (snapshot.status === 'execution_unknown')
      await model.executionUnknown(
        run.channelId,
        run.id,
        run.fence,
        snapshot.error || 'Native execution state is unknown',
      );
    if (snapshot.status === 'failed')
      await model.fail(
        run.channelId,
        run.id,
        run.fence,
        snapshot.error || 'Native execution state is unknown',
        !snapshot.physicalStopped,
      );
    if (snapshot.physicalStopped) await model.releaseWriter(run.channelId, run.id, run.fence);
  }

  async close() {
    for (const { abort } of this.active.values()) abort.abort();
    await Promise.allSettled([...this.active.values()].map((entry) => entry.done));
  }
}
