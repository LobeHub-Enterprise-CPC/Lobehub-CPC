import type { ChannelMemberConfig } from '@lobechat/types';
import debug from 'debug';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import pMap from 'p-map';

import { ChannelModel } from '@/database/models/channel';
import {
  channelDiscussions,
  channelJobs,
  channelMembers,
  channelMessages,
  channelRuns,
  channels,
} from '@/database/privateSchemas/channel';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';

import { resolveChannelArtifactRunIds, saveChannelArtifact } from './artifact';
import { ChannelDevice, ChannelDeviceStartError } from './device';
import { isChannelEnabled } from './gate';
import { checkChannelNativeAvailability } from './native/capabilities';
import { runChannelNative } from './native/host';
import { routeChannelMessage } from './router';
import { settleChannelServerDefaultOperation } from './serverDefault';

const log = debug('lobe-server:channel:worker');

/** Durable database queue consumer. No execution is tied to a browser or HTTP request. */
export class ChannelWorker {
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private ticking = false;
  private readonly finalizing = new Map<string, () => Promise<void>>();
  private readonly publicationFences = new Map<string, number>();
  private jobCursor?: { createdAt: string; id: string };

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly availability = checkChannelNativeAvailability,
  ) {}

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    let reconciling: Promise<unknown> | undefined;
    try {
      await Promise.all(
        [...this.finalizing.keys()]
          .filter((runId) => !this.active.has(runId))
          .map((runId) => this.finalize(runId)),
      );
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
            and(
              isNull(channelRuns.publishedMessageId),
              eq(channelRuns.publicationRevoked, false),
              eq(channelRuns.publicationStatus, 'pending'),
            ),
            and(eq(channelRuns.cleanupRequested, true), eq(channelRuns.physicalStopped, false)),
          ),
        );
      const liveIds = new Set(active.map(({ run }) => run.id));
      for (const runId of this.publicationFences.keys())
        if (!liveIds.has(runId)) this.publicationFences.delete(runId);
      reconciling = pMap(
        active,
        async (entry) => {
          if (this.finalizing.has(entry.run.id)) return;
          try {
            const { run, channel, memberActive } = entry;
            const config = run.executionConfig;
            if (!config)
              throw new Error('Run execution environment is missing; migration is required');
            const model = new ChannelModel(this.db, channel.ownerId);
            const enabled = await isChannelEnabled(this.db, channel.ownerId);
            if (!run.publicationRevoked && (!enabled || channel.archived || !memberActive))
              await model.stop(channel.id, { runId: run.id });
            const stopped = run.publicationRevoked || !enabled || channel.archived || !memberActive;
            if (stopped) {
              this.active.get(run.id)?.abort.abort();
              this.publicationFences.delete(run.id);
            }
            if (run.writerReleased && run.cleanupRequested && !run.physicalStopped) {
              try {
                if (!config.deviceId || config.runtime === 'native')
                  throw new Error('Old execution requires inspection before changing environment');
                const snapshot = await new ChannelDevice(
                  this.db,
                  channel.ownerId,
                  config.deviceId,
                ).stop(run.id, run.executionFence);
                const confirmed =
                  snapshot?.runId === run.id &&
                  snapshot.fence === run.executionFence &&
                  snapshot.physicalStopped === true;
                await model.recordEnvironmentCleanup(
                  channel.id,
                  run.id,
                  run.fence,
                  confirmed,
                  snapshot?.error,
                );
              } catch (error) {
                await model.recordEnvironmentCleanup(
                  channel.id,
                  run.id,
                  run.fence,
                  false,
                  String(error),
                );
              }
              return;
            }
            if (run.writerReleased && run.draft !== null && !run.publishedMessageId && !stopped) {
              try {
                const fence =
                  this.publicationFences.get(run.id) === run.fence
                    ? run.fence
                    : await model.recoverDraft(channel.id, run.id, run.fence);
                this.publicationFences.set(run.id, fence);
                await model.publish(channel.id, run.id, fence);
                this.publicationFences.delete(run.id);
              } catch (error) {
                log('Draft publication deferred: run=%s error=%s', run.id, error);
              }
              return;
            }
            if (config.runtime !== 'native' && config.deviceId) {
              try {
                await this.reconcileCodex(model, channel.ownerId, run, config, stopped);
              } catch (error) {
                await model.executionUnknown(channel.id, run.id, run.fence, String(error));
                if (run.cleanupRequested)
                  await model.recordEnvironmentCleanup(
                    channel.id,
                    run.id,
                    run.fence,
                    false,
                    String(error),
                  );
              }
            } else if (run.draft && !stopped) {
              await model.publish(channel.id, run.id, run.fence);
            } else if (!this.active.has(run.id) && !run.writerReleased) {
              // The operation ran headless inside a worker that is gone. Its tools
              // cannot be replayed or declared terminated by this one.
              await model.executionUnknown(
                channel.id,
                run.id,
                run.fence,
                'Native worker disconnected; execution requires inspection',
              );
            }
          } catch (error) {
            log('Run reconciliation deferred: run=%s error=%s', entry.run.id, error);
          }
        },
        { concurrency: 8 },
      );
      const pending = await this.db
        .select({ message: channelMessages, ownerId: channels.ownerId })
        .from(channelMessages)
        .innerJoin(channels, eq(channels.id, channelMessages.channelId))
        .innerJoin(users, eq(users.id, channels.ownerId))
        .where(
          and(
            eq(channelMessages.routingStatus, 'pending'),
            eq(channels.archived, false),
            // Filter before LIMIT so disabled owners cannot occupy the entire routing window.
            sql`${users.preference}->'lab'->'enableChannel' = 'true'::jsonb`,
          ),
        )
        .orderBy(asc(channelMessages.createdAt), asc(channelMessages.id))
        .limit(20);
      for (const { message, ownerId } of pending) {
        try {
          if (!(await isChannelEnabled(this.db, ownerId))) continue;
          await routeChannelMessage(
            new ChannelModel(this.db, ownerId),
            message.channelId,
            message.id,
          );
        } catch (error) {
          log('Routing deferred: %s', error);
        }
        // At most one enabled request per sweep: no parallel Jev calls or long routing batches.
        break;
      }
      const discussing = await this.db
        .selectDistinct({ channelId: channels.id, ownerId: channels.ownerId })
        .from(channelDiscussions)
        .innerJoin(channels, eq(channels.id, channelDiscussions.channelId))
        .where(
          and(
            inArray(channelDiscussions.status, ['active', 'summarizing']),
            eq(channels.archived, false),
          ),
        );
      for (const item of discussing) {
        if (!(await isChannelEnabled(this.db, item.ownerId))) continue;
        await new ChannelModel(this.db, item.ownerId).advanceDiscussions(item.channelId);
      }
      const jobs = await this.db
        .select({
          job: channelJobs,
          channel: channels,
          config: channelMembers.config,
          revision: channelMembers.environmentRevision,
          // Date truncates PostgreSQL microseconds and would repeatedly select the boundary row.
          cursorCreatedAt: sql<string>`${channelJobs.createdAt}::text`,
        })
        .from(channelJobs)
        .innerJoin(channels, eq(channels.id, channelJobs.channelId))
        .innerJoin(channelMembers, eq(channelMembers.id, channelJobs.memberId))
        .where(
          and(
            eq(channelJobs.status, 'queued'),
            eq(channels.archived, false),
            eq(channelMembers.active, true),
            eq(channelMembers.executionPaused, false),
            this.jobCursor
              ? sql`(${channelJobs.createdAt}, ${channelJobs.id}) > (${this.jobCursor.createdAt}::timestamptz, ${this.jobCursor.id})`
              : undefined,
          ),
        )
        .orderBy(asc(channelJobs.createdAt), asc(channelJobs.id))
        .limit(40);
      // Rotate through blocked candidates without dropping them; claim still enforces member FIFO.
      const last = jobs.at(-1);
      this.jobCursor =
        jobs.length === 40 && last
          ? { createdAt: last.cursorCreatedAt, id: last.job.id }
          : undefined;
      const jobResults = await Promise.allSettled(
        jobs.map(async ({ job, channel, config, revision }) => {
          if (!(await isChannelEnabled(this.db, channel.ownerId))) return;
          const model = new ChannelModel(this.db, channel.ownerId);
          let agentId: string | undefined;
          try {
            if (config.deviceId && config.workingDirectory) {
              const canonical = await new ChannelDevice(
                this.db,
                channel.ownerId,
                config.deviceId,
              ).probe(config.workingDirectory, config.runtime, config.agentId);
              if (canonical !== config.workingDirectory)
                throw new Error(
                  'WORKSPACE_CHANGED: The configured directory no longer resolves to its original workspace',
                );
            }
            if (config.runtime === 'native')
              agentId = (await this.availability(this.db, channel.ownerId, config)).agentId;
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
          const claim = await model.claim(channel.id, job.id, revision);
          if (!claim) return;
          config = claim.run.executionConfig!;
          if (config.runtime === 'native') {
            try {
              await this.startNative(model, channel.ownerId, claim.run, config, agentId!);
            } catch (error) {
              await model.fail(channel.id, claim.run.id, claim.run.fence, String(error));
              await model.releaseWriter(channel.id, claim.run.id, claim.run.fence);
            }
          } else if (config.deviceId && config.workingDirectory) {
            try {
              await new ChannelDevice(this.db, channel.ownerId, config.deviceId).start(
                {
                  cwd: config.workingDirectory,
                  fence: claim.run.executionFence,
                  manifest: claim.run.manifest,
                  model: config.model,
                  runtime: config.runtime,
                  systemRole: config.systemRole,
                  runId: claim.run.id,
                  sessionId: claim.session.nativeSessionId,
                },
                config.agentId,
              );
            } catch (error) {
              if (
                error instanceof ChannelDeviceStartError &&
                error.submission === 'not-submitted'
              ) {
                const failure = error.message;
                this.finalizing.set(claim.run.id, async () => {
                  // Preparation may create the operation and then fail while signing its token.
                  await settleChannelServerDefaultOperation({
                    db: this.db,
                    ownerId: channel.ownerId,
                    runId: claim.run.id,
                    status: 'error',
                  });
                  await model.fail(channel.id, claim.run.id, claim.run.fence, failure, false, true);
                });
                await this.finalize(claim.run.id);
              } else {
                // RPC dispatch may have been accepted: inspect on the next tick, never resend.
                log(
                  'Device start acknowledgement unavailable: run=%s error=%s',
                  claim.run.id,
                  error,
                );
              }
            }
          }
        }),
      );
      for (const result of jobResults)
        if (result.status === 'rejected') log('Job dispatch deferred: %s', result.reason);
    } finally {
      await reconciling;
      this.ticking = false;
    }
  }

  private async startNative(
    model: ChannelModel,
    ownerId: string,
    run: typeof channelRuns.$inferSelect,
    config: ChannelMemberConfig,
    agentId: string,
  ) {
    const artifactRunIds = await resolveChannelArtifactRunIds(this.db, ownerId, run);
    const abort = new AbortController();
    const done = this.native(model, ownerId, run, config, { agentId, artifactRunIds }, abort)
      .catch((error) => log('Native execution settlement deferred: run=%s error=%s', run.id, error))
      .finally(() => {
        this.active.delete(run.id);
      });
    this.active.set(run.id, { abort, done });
  }

  private async native(
    model: ChannelModel,
    ownerId: string,
    run: typeof channelRuns.$inferSelect,
    config: ChannelMemberConfig,
    input: { agentId: string; artifactRunIds: string[] },
    abort: AbortController,
  ) {
    let draftSaved = false;
    let failure: string | undefined;
    try {
      const result = await runChannelNative({
        ...input,
        db: this.db,
        onAccepted: (sessionId, operationId) =>
          model.accepted(run.channelId, run.id, run.fence, sessionId, operationId),
        ownerId,
        run,
        signal: abort.signal,
      });
      if (abort.signal.aborted) throw new Error('Native execution was interrupted');
      await model.recordExecution(run.channelId, run.id, run.fence, {
        runtime: 'native',
        model: result.state.modelRuntimeConfig?.model ?? config.model,
        provider: result.state.modelRuntimeConfig?.provider ?? config.provider,
        ...result.budget,
      });
      await model.saveDraft(run.channelId, run.id, run.fence, result.content);
      draftSaved = true;
      await model.publish(run.channelId, run.id, run.fence);
    } catch (error) {
      log('Native execution failed: run=%s error=%s', run.id, error);
      if (!draftSaved) failure = error instanceof Error ? error.message : String(error);
    } finally {
      // Tool termination is the runtime's job: `executeSync` returns only after
      // the step that ran them has been persisted, so the writer can be released.
      this.finalizing.set(run.id, async () => {
        if (failure) await model.fail(run.channelId, run.id, run.fence, failure);
        await model.releaseWriter(run.channelId, run.id, run.fence);
      });
      await this.finalize(run.id);
    }
  }

  private async finalize(runId: string) {
    const finalize = this.finalizing.get(runId);
    if (!finalize) return;
    try {
      await finalize();
      this.finalizing.delete(runId);
    } catch (error) {
      log('Native finalization will retry: run=%s error=%s', runId, error);
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
      ? await device.stop(run.id, run.executionFence)
      : await device.inspect(run.id, run.executionFence);
    if (!snapshot) {
      await model.executionUnknown(
        run.channelId,
        run.id,
        run.fence,
        'Device has no receipt; this Run will not be resubmitted',
      );
      if (run.cleanupRequested)
        await model.recordEnvironmentCleanup(
          run.channelId,
          run.id,
          run.fence,
          false,
          'Device has no execution receipt',
        );
      return;
    }
    if (snapshot.fence !== run.executionFence || snapshot.runId !== run.id)
      throw new Error('Stale device receipt');
    const settled =
      snapshot.physicalStopped ||
      (!stopped && snapshot.status === 'completed' && snapshot.runtimeCompleted === true);
    if (settled && (stopped || snapshot.status === 'completed' || snapshot.status === 'failed'))
      await settleChannelServerDefaultOperation({
        db: this.db,
        ownerId,
        runId: run.id,
        status: stopped ? 'interrupted' : snapshot.status === 'completed' ? 'done' : 'error',
      });
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
          run.executionFence,
          snapshot.approval.id,
          approval.decision === 'approved',
        );
    }
    if (!stopped && snapshot.status === 'completed' && snapshot.content && settled) {
      await model.recordExecution(run.channelId, run.id, run.fence, {
        runtime: config.runtime,
        model: config.model,
        modelCalls: snapshot.modelCalls,
        toolCalls: snapshot.toolCalls,
      });
      if (snapshot.evidence?.final)
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
        !settled,
      );
    if (snapshot.physicalStopped || run.cleanupRequested)
      await model.recordEnvironmentCleanup(
        run.channelId,
        run.id,
        run.fence,
        snapshot.physicalStopped,
        snapshot.error,
      );
    if (settled) await model.releaseWriter(run.channelId, run.id, run.fence);
  }

  async close() {
    for (const { abort } of this.active.values()) abort.abort();
    await Promise.allSettled([...this.active.values()].map((entry) => entry.done));
    await Promise.all([...this.finalizing.keys()].map((runId) => this.finalize(runId)));
  }
}
