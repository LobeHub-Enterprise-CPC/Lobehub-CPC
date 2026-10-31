// @vitest-environment node
import { type LobeChatDatabase } from '@lobechat/database';
import { agentOperations, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentOperationModel } from '@/database/models/agentOperation';

import { persistCompletion } from './persistence';
import type { CompletionLifecycleDeps } from './types';

const userId = 'persist-completion-replay-user';
const operationId = 'op-persist-completion-replay';

let serverDB: LobeChatDatabase;

beforeEach(async () => {
  serverDB = await getTestDB();
  await serverDB.insert(users).values({ id: userId }).onConflictDoNothing();
});

afterEach(async () => {
  await serverDB.delete(agentOperations).where(eq(agentOperations.id, operationId));
  await serverDB.delete(users).where(eq(users.id, userId));
});

/**
 * The Hatchet completion replay re-runs `persistCompletion` on a row the first
 * attempt already finished. Its hooks only fire when that write is accepted,
 * which rests on `recordCompletion` matching a row in the same status.
 */
describe('persistCompletion on a replayed completion lifecycle', () => {
  it('accepts the same terminal outcome again, and still refuses a different one', async () => {
    const agentOperationModel = new AgentOperationModel(serverDB, userId);
    const deps: CompletionLifecycleDeps = {
      agentOperationModel,
      includeShareVisitor: false,
      messageModel: {} as CompletionLifecycleDeps['messageModel'],
      serverDB,
      userId,
    };
    await agentOperationModel.recordStart({ operationId });
    const state = { status: 'done', stepCount: 2 };

    await expect(persistCompletion(deps, operationId, state, 'done')).resolves.toBe(true);
    await expect(persistCompletion(deps, operationId, state, 'done')).resolves.toBe(true);
    await expect(
      persistCompletion(deps, operationId, { ...state, status: 'error' }, 'error'),
    ).resolves.toBe(false);
    expect(await agentOperationModel.findById(operationId)).toMatchObject({ status: 'done' });
  });
  it('propagates a terminal database failure only in strict mode', async () => {
    const failure = new Error('database unavailable');
    const deps = {
      agentOperationModel: {
        recordCompletion: vi.fn().mockRejectedValue(failure),
        sumChildUsage: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as CompletionLifecycleDeps;
    await expect(persistCompletion(deps, operationId, {}, 'done', false, true)).rejects.toBe(
      failure,
    );
    await expect(persistCompletion(deps, operationId, {}, 'done')).resolves.toBe(true);
  });
});
