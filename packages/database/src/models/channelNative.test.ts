// @vitest-environment node
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import type { LLMAttemptInput } from '@lobechat/agent-runtime';
import { drizzle } from 'drizzle-orm/pglite';
import { expect, it, vi } from 'vitest';

import { ChannelModel } from '@/database/models/channel';
import * as schema from '@/database/schemas/channel';
import type { LobeChatDatabase } from '@/database/type';

import { createChannelContextBuilder } from '../../../../apps/server/src/services/channel/native/context';
import { runChannelNative } from '../../../../apps/server/src/services/channel/native/host';

const probe = vi.hoisted(() => ({
  modelCalls: 0,
  contexts: [] as LLMAttemptInput['context'][],
}));
vi.mock('../../../../apps/server/src/services/channel/native/llm', () => ({
  createChannelLLMTransport: () => ({
    retryPolicy: {
      classifyError: () => ({ kind: 'stop' }),
      maxAttempts: () => 1,
      resolveRetryBudget: () => 0,
    },
    runAttempt: async (input: LLMAttemptInput) => {
      probe.contexts.push(input.context);
      const first = ++probe.modelCalls === 1;
      return {
        ok: true,
        output: {
          answerSalvagedFromReasoning: false,
          content: first ? '' : 'Verified fixture',
          contentParts: [],
          grounding: null,
          hasContentImages: false,
          hasReasoningImages: false,
          imageList: [],
          reasoningParts: [],
          thinkingContent: '',
          toolCalls: first
            ? [
                {
                  id: 'approved-call',
                  type: 'function',
                  function: { name: 'fixture____read____builtin', arguments: '{}' },
                },
              ]
            : [],
          toolsCalling: first
            ? [
                {
                  id: 'approved-call',
                  type: 'builtin',
                  identifier: 'fixture',
                  apiName: 'read',
                  arguments: '{}',
                },
              ]
            : [],
        },
      };
    },
  }),
}));

it.each([false, true])(
  'resumes an approved batch once, including worker restart=%s',
  async (restart) => {
    const client = new PGlite();
    try {
      await client.exec(
        "create table users (id text primary key); insert into users values ('owner');",
      );
      await client.exec(
        readFileSync(
          new URL('../../migrations/0163_channel_mvp.sql', import.meta.url),
          'utf8',
        ).replaceAll('--> statement-breakpoint', ''),
      );
      const db = drizzle(client, { schema }) as unknown as LobeChatDatabase;
      const model = new ChannelModel(db, 'owner');
      const config = { runtime: 'native' as const, provider: 'fixture', model: 'fixture' };
      const channel = await model.create('Approval regression', [
        { name: 'Native', config },
        { name: 'Reviewer', config },
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
      let approvals = 0;
      let toolCalls = 0;
      probe.modelCalls = 0;
      probe.contexts = [];
      const customBuild = vi.fn(createChannelContextBuilder().build);
      const input: Parameters<typeof runChannelNative>[0] = {
        db,
        ownerId: 'owner',
        runId: run.id,
        fence: 1,
        config,
        signal: AbortSignal.timeout(10000),
        onAccepted: (session, turn) => model.accepted(channel.id, run.id, 1, session, turn),
        onApproval: async () => {
          expect(toolCalls).toBe(0);
          approvals++;
        },
        capabilities: {
          systemRole: 'Original native role',
          ...(restart && { context: { build: customBuild } }),
          tools: [
            {
              type: 'function',
              function: {
                name: 'fixture____read____builtin',
                description: 'Read fixture',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
          toolManifestMap: {
            fixture: {
              identifier: 'fixture',
              api: [
                {
                  name: 'read',
                  description: 'Read fixture',
                  humanIntervention: 'required',
                  parameters: { type: 'object', properties: {} },
                },
              ],
            },
          },
          toolTransport: {
            run: async () => {
              toolCalls++;
              return { attempts: 1, result: { success: true, content: 'Fixture contents' } };
            },
          },
        },
      };
      if (restart) {
        await expect(
          runChannelNative({
            ...input,
            onApproval: async () => {
              throw new Error('Simulated process disconnect before approval');
            },
          }),
        ).rejects.toThrow('Simulated process disconnect');
        expect(toolCalls).toBe(0);
        expect(probe.modelCalls).toBe(1);
      }
      const result = await runChannelNative(input);
      expect(result.content).toBe('Verified fixture');
      expect(result.state.status).toBe('done');
      expect(approvals).toBe(1);
      expect(toolCalls).toBe(1);
      expect(probe.modelCalls).toBe(2);
      if (restart) expect(customBuild).toHaveBeenCalledTimes(2);
      for (const context of probe.contexts) {
        const messages = context.messages as { content: unknown; role: string }[];
        const system = String(messages.find((m) => m.role === 'system')?.content);
        expect(system).toContain('Original native role');
        expect(system).toContain('author.id equals self.memberId');
        expect(system.split('This request was delivered through a Channel.')).toHaveLength(2);
        expect(JSON.parse(system.slice(system.indexOf('{')))).toEqual({
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
        const background = messages.find(
          (m) => m.role === 'user' && String(m.content).includes('"kind":"channel_history"'),
        )!;
        expect(background.role).toBe('user');
        expect(JSON.parse(String(background.content))).toMatchObject({
          author: { id: 'owner', type: 'human' },
          content: 'Background only',
          threadId: null,
        });
      }
      expect(result.state.systemRole).toBe('Original native role');
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
        runId: summary.run.id,
        onAccepted: (session, turn) => model.accepted(channel.id, summary.run.id, 1, session, turn),
      });
      expect(synthesis.content).toBe('Verified fixture');
      expect(toolCalls).toBe(1);
      expect(probe.modelCalls).toBe(3);
    } finally {
      await client.close();
    }
  },
  30000,
);
