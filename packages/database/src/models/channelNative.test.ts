// @vitest-environment node
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import type { AgentState } from '@lobechat/agent-runtime';
import type { UIChatMessage } from '@lobechat/types';
import { drizzle } from 'drizzle-orm/pglite';
import { expect, it, vi } from 'vitest';

import { ChannelModel } from '@/database/models/channel';
import { ChannelRuntimeModel } from '@/database/models/channelRuntime';
import type { LobeChatDatabase } from '@/database/type';
import type { RuntimeMessageStore } from '@/server/modules/AgentRuntime/context';

import { runChannelNative } from '../../../../apps/server/src/services/channel/native/host';
import * as schema from '../privateSchemas/channel';

/**
 * Stand-in for `AiAgentService`: records what the Channel host hands to
 * `execAgent`, then plays one tool step and one final step through the
 * `RuntimeMessageStore` the host injected, the way the runtime would.
 */
const probe = vi.hoisted(() => ({
  execAgent: [] as any[],
  stores: [] as RuntimeMessageStore[],
}));
vi.mock('../../../../apps/server/src/services/aiAgent', () => ({
  AiAgentService: class {
    private readonly store: RuntimeMessageStore;
    private operation = 0;
    constructor(_db: unknown, _ownerId: string, options: { runtimeOptions: any }) {
      this.store = options.runtimeOptions.messageStore;
      probe.stores.push(this.store);
      if (options.runtimeOptions.queueService !== null) throw new Error('queue must be disabled');
    }
    execAgent = async (params: unknown) => {
      probe.execAgent.push(params);
      return { operationId: `op_${++this.operation}_${probe.execAgent.length}`, success: true };
    };
    executeSync = async (
      operationId: string,
      { onStepComplete }: { onStepComplete: (i: number, s: AgentState) => Promise<void> },
    ): Promise<AgentState> => {
      const step = async (index: number, content: string, tool?: boolean) => {
        const assistant = await this.store.create({
          content: '',
          metadata: { operationId },
          role: 'assistant',
          clientId: `agent-runtime:${operationId}:step:${index}:instruction:0:assistant`,
        });
        if (tool) {
          const call = await this.store.create({
            content: '',
            parentId: assistant.id,
            role: 'tool',
            tool_call_id: `call_${index}`,
            plugin: {
              apiName: 'read',
              arguments: '{}',
              identifier: 'channel-artifact',
              type: 'builtin',
            },
          });
          await this.store.updateToolMessage(call.id, { content: 'Fixture contents' });
          await this.store.update(assistant.id, {
            content,
            tools: [{ id: `call_${index}` }] as UIChatMessage['tools'],
          });
        } else await this.store.update(assistant.id, { content });
        const state = {
          status: 'running',
          usage: { llm: { apiCalls: index + 1 }, tools: { totalCalls: tool ? 1 : 0 } },
        } as AgentState;
        await onStepComplete(index, state);
        return state;
      };
      await step(0, '', true);
      await step(1, 'Verified fixture');
      return {
        modelRuntimeConfig: { model: 'fixture', provider: 'fixture' },
        status: 'done',
        usage: { llm: { apiCalls: 2 }, tools: { totalCalls: 1 } },
      } as AgentState;
    };
    interruptOperation = async () => true;
  },
}));

it('runs a Channel member through execAgent against the private transcript only', async () => {
  const client = new PGlite();
  try {
    // No `messages` / `topics` tables exist here: any chat-table write would fail loudly.
    await client.exec(
      "create table users (id text primary key); insert into users values ('owner');",
    );
    await client.exec(
      readFileSync(
        new URL(
          '../../../../../packages/enterprise/src/database/migrations/0009_channel_mvp.sql',
          import.meta.url,
        ),
        'utf8',
      ).replaceAll('--> statement-breakpoint', ''),
    );
    const db = drizzle(client, { schema }) as unknown as LobeChatDatabase;
    const model = new ChannelModel(db, 'owner');
    const config = {
      agentId: 'agent',
      model: 'fixture',
      provider: 'fixture',
      runtime: 'native' as const,
    };
    const channel = await model.create('execAgent regression', [
      { name: 'Native', config },
      { name: 'Reviewer', config: { ...config, agentId: 'reviewer' } },
    ]);
    const member = (await model.detail(channel.id)).members[0];
    const root = await model.send(channel.id, {
      content: 'Background only',
      mentions: [],
      requestKey: 'background',
    });
    await model.stop(channel.id, { threadId: null });
    const thread = await model.branch(channel.id, root.id);
    await model.send(channel.id, {
      content: 'Read fixture',
      mode: 'discussion',
      mentions: [member.id],
      requestKey: 'fixture',
      threadId: thread.id,
      // A single round: the publication below ends the discussion instead of opening round 2.
      maxDiscussionRounds: 1,
    });
    const { run } = (await model.claim(
      channel.id,
      (await model.detail(channel.id)).jobs.find((job) => job.status === 'queued')!.id,
    ))!;
    probe.execAgent = [];
    probe.stores = [];
    const accepted: string[] = [];
    const input: Parameters<typeof runChannelNative>[0] = {
      agentId: 'agent',
      artifactRunIds: [],
      db,
      onAccepted: async (session, operationId) => {
        accepted.push(operationId);
        await model.accepted(channel.id, run.id, 1, session, operationId);
      },
      ownerId: 'owner',
      run,
      signal: AbortSignal.timeout(10_000),
    };
    const result = await runChannelNative(input);
    expect(result.content).toBe('Verified fixture');
    expect(result.budget).toMatchObject({ modelCalls: 2, toolCalls: 1 });
    expect(accepted).toEqual([result.operationId]);

    // The host passed the run through execAgent as a transcript, not a topic.
    const params = probe.execAgent[0];
    expect(params).toMatchObject({
      agentId: 'agent',
      autoStart: false,
      channelContext: { channelId: channel.id, fence: 1, runId: run.id },
      trigger: 'channel',
      userInterventionConfig: { approvalMode: 'headless' },
    });
    expect(params.appContext?.topicId).toBeUndefined();
    expect(params.serverToolManifests).toBeUndefined();
    const introduced = JSON.parse(params.instructions.slice(params.instructions.indexOf('{')));
    expect(introduced).toEqual({
      discussion: {
        id: run.manifest.requestMessageId,
        kind: 'discuss',
        maxRounds: 1,
        round: 1,
        participants: [{ memberId: member.id, name: member.name }],
      },
      deliveryInstruction: expect.stringContaining('Participate freely'),
      self: { memberId: member.id, name: member.name },
      threadId: thread.id,
      threadRootSequence: 1,
      cutoffSequence: 2,
      contextMode: 'snapshot',
      activeRequestMessageId: run.manifest.requestMessageId,
    });

    // Everything landed in the private session, including the runtime's own rows.
    const transcript = await new ChannelRuntimeModel(db, 'owner', run.id, 1).messages();
    const background = transcript.find(
      (m) => m.role === 'user' && String(m.content).includes('"kind":"channel_history"'),
    )!;
    expect(JSON.parse(String(background.content))).toMatchObject({
      author: { id: 'owner', type: 'human' },
      content: 'Background only',
      threadId: null,
    });
    const delivery = transcript.find((m) =>
      String(m.content).includes('"kind":"channel_request"'),
    )!;
    expect(delivery.id).toBe(params.transcript.deliveryMessageId);
    expect(transcript.filter((m) => m.role === 'assistant')).toHaveLength(2);
    expect(transcript.find((m) => m.role === 'tool')).toMatchObject({
      content: 'Fixture contents',
      tool_call_id: 'call_0',
    });
    const { checkpoint } = await new ChannelRuntimeModel(db, 'owner', run.id, 1).load();
    expect(checkpoint).toEqual({
      operationId: result.operationId,
      phase: 'accepted',
      runId: run.id,
    });

    // A second attempt on the same run must not create a second operation.
    await expect(runChannelNative(input)).rejects.toThrow('checkpoint exists');
    expect(probe.execAgent).toHaveLength(1);

    await model.saveDraft(channel.id, run.id, 1, result.content);
    await model.publish(channel.id, run.id, 1);
    await model.releaseWriter(channel.id, run.id, 1);
    await model.advanceDiscussions(channel.id);
    const summaryJob = (await model.detail(channel.id)).jobs.find(
      (job) => job.task?.kind === 'summarize',
    )!;
    const summary = (await model.claim(channel.id, summaryJob.id))!;
    expect(summary.run.manifest.messages.map((message) => message.content)).toEqual([
      'Verified fixture',
    ]);
    const synthesis = await runChannelNative({
      ...input,
      onAccepted: (session, op) => model.accepted(channel.id, summary.run.id, 1, session, op),
      run: summary.run,
    });
    expect(synthesis.content).toBe('Verified fixture');
    expect(probe.execAgent).toHaveLength(2);
    expect(
      JSON.parse(
        probe.execAgent[1].instructions.slice(probe.execAgent[1].instructions.indexOf('{')),
      ),
    ).toMatchObject({ discussion: { kind: 'summarize' } });
  } finally {
    await client.close();
  }
}, 30_000);
