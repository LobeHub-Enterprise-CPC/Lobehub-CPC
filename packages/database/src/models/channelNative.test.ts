// @vitest-environment node
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { expect, it, vi } from 'vitest';

import { ChannelModel } from '@/database/models/channel';
import * as schema from '@/database/schemas/channel';
import type { LobeChatDatabase } from '@/database/type';

import { runChannelNative } from '../../../../apps/server/src/services/channel/native/host';

const probe = vi.hoisted(() => ({ modelCalls: 0 }));
vi.mock('../../../../apps/server/src/services/channel/native/llm', () => ({
  createChannelLLMTransport: () => ({
    retryPolicy: {
      classifyError: () => ({ kind: 'stop' }),
      maxAttempts: () => 1,
      resolveRetryBudget: () => 0,
    },
    runAttempt: async () => {
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
      for (const migration of ['0159_channel_mvp.sql', '0160_channel_native_transcript.sql'])
        await client.exec(
          readFileSync(
            new URL(`../../migrations/${migration}`, import.meta.url),
            'utf8',
          ).replaceAll('--> statement-breakpoint', ''),
        );
      const db = drizzle(client, { schema }) as unknown as LobeChatDatabase;
      const model = new ChannelModel(db, 'owner');
      const config = { runtime: 'native' as const, provider: 'fixture', model: 'fixture' };
      const channel = await model.create('Approval regression', [{ name: 'Native', config }]);
      const member = (await model.detail(channel.id)).members[0];
      await model.send(channel.id, {
        content: 'Read fixture',
        mentions: [member.id],
        requestKey: 'fixture',
      });
      const { run } = (await model.claim(channel.id, (await model.detail(channel.id)).jobs[0].id))!;
      let approvals = 0;
      let toolCalls = 0;
      probe.modelCalls = 0;
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
    } finally {
      await client.close();
    }
  },
  30000,
);
