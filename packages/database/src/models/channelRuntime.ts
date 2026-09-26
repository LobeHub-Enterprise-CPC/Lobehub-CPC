import { randomUUID } from 'node:crypto';

import type { UIChatMessage } from '@lobechat/types';
import { and, asc, eq } from 'drizzle-orm';

import {
  channelRuns,
  channelRuntimeMessages,
  channelRuntimeStates,
  channels,
} from '../schemas/channel';
import type { LobeChatDatabase, Transaction } from '../type';
import { ChannelError } from './channel';

/** A private store bound to a single owner, Run and fencing generation. */
export class ChannelRuntimeModel {
  constructor(
    private db: LobeChatDatabase,
    private ownerId: string,
    private runId: string,
    private fence: number,
  ) {}

  private async guard(tx: Transaction, write = false) {
    const [scope] = await tx
      .select({ channelId: channelRuns.channelId })
      .from(channelRuns)
      .innerJoin(channels, eq(channels.id, channelRuns.channelId))
      .where(and(eq(channels.ownerId, this.ownerId), eq(channelRuns.id, this.runId)));
    if (!scope) throw new ChannelError('CONFLICT', 'Native Run authority was revoked');
    await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, scope.channelId))
      .for('update');
    const [run] = await tx
      .select()
      .from(channelRuns)
      .where(and(eq(channelRuns.id, this.runId), eq(channelRuns.fence, this.fence)))
      .for('update');
    if (!run || (write && run.publicationRevoked))
      throw new ChannelError('CONFLICT', 'Native Run authority was revoked');
    return run;
  }

  async messages(raw = false) {
    return this.db.transaction(async (tx) => {
      const run = await this.guard(tx);
      const messages = (
        await tx
          .select()
          .from(channelRuntimeMessages)
          .where(eq(channelRuntimeMessages.sessionId, run.sessionId))
          .orderBy(asc(channelRuntimeMessages.createdAt), asc(channelRuntimeMessages.id))
      ).map((row) => row.data);
      if (raw) return messages;
      const hidden = new Set(
        messages.flatMap((message) =>
          (message.compressedMessages || []).map((source) => source.id),
        ),
      );
      return messages
        .filter((message) => !hidden.has(message.id))
        .sort((a, b) => a.createdAt - b.createdAt);
    });
  }

  async createMessage(data: UIChatMessage, stableKey: string = randomUUID()) {
    return this.db.transaction(async (tx) => {
      const run = await this.guard(tx, true);
      const [row] = await tx
        .insert(channelRuntimeMessages)
        .values({ id: data.id, sessionId: run.sessionId, runId: run.id, stableKey, data })
        .onConflictDoUpdate({
          target: [channelRuntimeMessages.sessionId, channelRuntimeMessages.stableKey],
          set: { stableKey },
        })
        .returning();
      return row.data;
    });
  }

  async updateMessage(id: string, patch: (message: UIChatMessage) => UIChatMessage) {
    await this.db.transaction(async (tx) => {
      const run = await this.guard(tx, true);
      const [row] = await tx
        .select()
        .from(channelRuntimeMessages)
        .where(
          and(
            eq(channelRuntimeMessages.sessionId, run.sessionId),
            eq(channelRuntimeMessages.id, id),
          ),
        );
      if (!row) throw new ChannelError('NOT_FOUND', 'Private runtime message not found');
      await tx
        .update(channelRuntimeMessages)
        .set({ data: { ...patch(row.data), id: row.id } })
        .where(eq(channelRuntimeMessages.id, id));
    });
  }

  async deleteMessage(id: string) {
    await this.db.transaction(async (tx) => {
      const run = await this.guard(tx, true);
      await tx
        .delete(channelRuntimeMessages)
        .where(
          and(
            eq(channelRuntimeMessages.sessionId, run.sessionId),
            eq(channelRuntimeMessages.id, id),
          ),
        );
    });
  }

  async load() {
    return this.db.transaction(async (tx) => {
      const run = await this.guard(tx);
      const [record] = await tx
        .select()
        .from(channelRuntimeStates)
        .where(eq(channelRuntimeStates.sessionId, run.sessionId));
      return { run, checkpoint: record?.state };
    });
  }

  async save(state: Record<string, unknown>) {
    await this.db.transaction(async (tx) => {
      const run = await this.guard(tx, true);
      await tx
        .insert(channelRuntimeStates)
        .values({ sessionId: run.sessionId, runId: run.id, state })
        .onConflictDoUpdate({
          target: channelRuntimeStates.sessionId,
          set: { runId: run.id, state },
        });
    });
  }
}
