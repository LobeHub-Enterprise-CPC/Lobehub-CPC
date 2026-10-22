import { parse } from '@lobechat/conversation-flow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getPendingInterventions } from '@/features/Conversation/store/slices/data/pendingInterventions';
import { collectGlobalApprovals } from '@/features/GlobalApprovalNotification/useGlobalPendingApprovals';
import { messageService } from '@/services/message';
import { initialState } from '@/store/chat/initialState';
import { MessageInternalsActionImpl } from '@/store/chat/slices/message/actions/internals';
import { OperationActionsImpl } from '@/store/chat/slices/operation/actions';
import type { Operation } from '@/store/chat/slices/operation/types';
import type { ChatStore } from '@/store/chat/store';
import { messageMapKey } from '@/store/chat/utils/messageMapKey';
import type { StoreSetter } from '@/store/types';

import { QuestionSubmissionActionImpl } from '../entries/questionSubmission';
import { createMockMessage } from './fixtures';

vi.mock('@/services/message', () => ({ messageService: { getMessages: vi.fn() } }));

const context = { agentId: 'agent-question', topicId: 'topic-question' };
const key = messageMapKey(context);
const question = createMockMessage({
  agentId: context.agentId,
  content: '',
  id: 'question',
  parentId: 'assistant-question',
  plugin: {
    apiName: 'askUserQuestion',
    arguments: '{}',
    identifier: 'lobe-agent',
    type: 'default',
  },
  pluginIntervention: { batchId: 'batch', operationId: 'operation', status: 'pending' },
  pluginState: { askUserDraft: { picks: { Color: ['Blue'] }, supplementText: 'Keep my note' } },
  role: 'tool',
  tool_call_id: 'call-question',
  topicId: context.topicId,
});
const assistant = createMockMessage({
  content: 'Streaming continuation',
  id: question.parentId!,
  role: 'assistant',
  tools: [
    { ...question.plugin!, id: question.tool_call_id!, intervention: question.pluginIntervention },
  ],
});
const answered = {
  ...question,
  content: 'User submitted answers',
  pluginIntervention: { ...question.pluginIntervention, status: 'approved' as const },
  pluginState: { askUserAnswers: { Color: ['Red'] } },
};

const createAction = () => {
  // The dispatcher writes through the message transcript replica, so the store
  // starts from the real initial state rather than only the maps read here.
  const state = {
    ...initialState,
    dbMessagesMap: { [key]: [question, assistant] },
    messagesMap: { [key]: parse([question, assistant]).flatList },
    questionSubmissions: {},
    refreshMessages: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatStore;
  const set: StoreSetter<ChatStore> = (update) => {
    Object.assign(state, typeof update === 'function' ? update(state) : update);
  };
  state.internal_getConversationContext = new OperationActionsImpl(
    set,
    () => state,
  ).internal_getConversationContext;
  state.internal_dispatchMessage = new MessageInternalsActionImpl(
    set,
    () => state,
  ).internal_dispatchMessage;
  const action = new QuestionSubmissionActionImpl(set, () => state);
  return { action, state };
};

beforeEach(() => {
  vi.mocked(messageService.getMessages).mockReset();
});

describe('question submission feedback', () => {
  it('collapses immediately without changing the pending row and blocks duplicate clicks', async () => {
    const { action, state } = createAction();
    const request = Promise.withResolvers<void>();
    const submit = vi.fn(() => request.promise);
    const pending = action.runQuestionSubmission(question.id, context, submit);
    expect(state.questionSubmissions.question).toBe('submitting');
    expect(state.dbMessagesMap[key][0]).toEqual(question);
    await action.runQuestionSubmission(question.id, context, submit);
    expect(submit).toHaveBeenCalledOnce();
    vi.mocked(messageService.getMessages).mockResolvedValueOnce([answered]);
    request.resolve();
    await pending;
    expect(state.questionSubmissions.question).toBeUndefined();
    expect(getPendingInterventions(state.messagesMap[key])).toEqual([]);
  });

  it.each(['submit_answers', 'skip_interaction'] as const)(
    'settles %s locally on confirmation without waiting for message revalidation',
    async (type) => {
      const { action, state } = createAction();
      state.refreshMessages = vi.fn(() => new Promise<void>(() => {}));
      action.internal_confirmQuestionSubmission(
        question.id,
        type === 'submit_answers' ? { type, result: { Color: ['Blue'] } } : { type },
        context,
      );
      expect(state.dbMessagesMap[key][0].pluginIntervention?.status).toBe(
        type === 'submit_answers' ? 'approved' : 'rejected',
      );
      expect(state.dbMessagesMap[key][0].pluginState).toMatchObject(question.pluginState!);
      if (type === 'submit_answers') {
        expect(state.dbMessagesMap[key][0].pluginState).toHaveProperty('askUserAnswers', {
          Color: ['Blue'],
        });
      }
    },
  );

  it('restores the saved answers after a failed submit and authoritative pending read', async () => {
    const { action, state } = createAction();
    const error = new Error('submit failed');
    vi.mocked(messageService.getMessages).mockResolvedValue([question]);
    await expect(
      action.runQuestionSubmission(question.id, context, async () => {
        throw error;
      }),
    ).rejects.toThrow(error);
    expect(state.questionSubmissions.question).toBe('failed');
    expect(state.dbMessagesMap[key][0].pluginState).toEqual(question.pluginState);
    vi.mocked(messageService.getMessages).mockResolvedValueOnce([answered]);
    const retry = vi.fn().mockResolvedValue(undefined);
    await action.runQuestionSubmission(question.id, context, retry);
    expect(retry).toHaveBeenCalledOnce();
  });

  it('reconciles a successful legacy answer without a push into both projections and its background bucket', async () => {
    const { action, state } = createAction();
    const currentContext = { agentId: 'other-agent', topicId: 'other-topic' };
    const currentKey = messageMapKey(currentContext);
    const currentMessages = [createMockMessage({ content: 'Current topic must not change' })];
    state.activeAgentId = currentContext.agentId;
    state.activeTopicId = currentContext.topicId;
    state.dbMessagesMap[currentKey] = currentMessages;
    expect(getPendingInterventions(state.messagesMap[key])).toHaveLength(1);
    const parkedRun = { context, status: 'completed' } as Operation;
    expect(
      collectGlobalApprovals(state.dbMessagesMap, { operation: parkedRun }, currentKey),
    ).toHaveLength(1);
    expect(collectGlobalApprovals(state.dbMessagesMap, {}, currentKey)).toHaveLength(1);
    // A plugin row can resolve without advancing the message timestamp.
    expect(answered.updatedAt).toBe(question.updatedAt);
    vi.mocked(messageService.getMessages).mockResolvedValueOnce([answered]);
    const submit = vi.fn().mockResolvedValue(undefined);

    await action.runQuestionSubmission(question.id, context, submit);

    expect(messageService.getMessages).toHaveBeenCalledExactlyOnceWith({
      ...context,
      skipWorks: true,
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(state.dbMessagesMap[key][0].pluginIntervention?.status).toBe('approved');
    expect(state.dbMessagesMap[key][0].pluginState).toMatchObject({
      ...question.pluginState,
      askUserAnswers: { Color: ['Red'] },
    });
    expect(state.dbMessagesMap[key][1].tools?.[0].intervention?.status).toBe('approved');
    expect(state.dbMessagesMap[key][1].content).toBe(assistant.content);
    expect(state.dbMessagesMap[currentKey]).toBe(currentMessages);
    expect(state.questionSubmissions.question).toBeUndefined();
    expect(getPendingInterventions(state.messagesMap[key])).toEqual([]);
    expect(collectGlobalApprovals(state.dbMessagesMap, {}, currentKey)).toEqual([]);
    // A remounted card in another topic consumes this same canonical bucket.
    expect(collectGlobalApprovals({ [key]: state.dbMessagesMap[key] }, {}, null)).toEqual([]);
  });

  it.each(['missing', 'offline'])(
    'keeps an acknowledged but %s resolution uncertain without resubmitting',
    async (result) => {
      const { action, state } = createAction();
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      if (result === 'missing') vi.mocked(messageService.getMessages).mockResolvedValueOnce([]);
      else vi.mocked(messageService.getMessages).mockRejectedValueOnce(new Error('offline'));
      const submit = vi.fn().mockResolvedValue(undefined);

      await expect(action.runQuestionSubmission(question.id, context, submit)).rejects.toThrow(
        'could not be confirmed',
      );
      expect(state.questionSubmissions.question).toBe('uncertain');
      expect(state.dbMessagesMap[key][0]).toEqual(question);
      await action.runQuestionSubmission(question.id, context, submit);
      expect(submit).toHaveBeenCalledOnce();
      vi.mocked(messageService.getMessages).mockResolvedValueOnce([answered]);
      expect(await action.checkQuestionSubmission(question.id, context)).toBe(true);
      expect(state.questionSubmissions.question).toBeUndefined();
      expect(submit).toHaveBeenCalledOnce();
      log.mockRestore();
    },
  );

  it('adopts a server-confirmed answer after a lost response without reopening the form', async () => {
    const { action, state } = createAction();
    vi.mocked(messageService.getMessages).mockResolvedValue([
      {
        ...question,
        content: 'Already answered',
        pluginIntervention: { status: 'approved' },
        pluginState: { askUserAnswers: { Color: ['Red'] } },
      },
    ]);
    await action.runQuestionSubmission(question.id, context, async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(state.questionSubmissions.question).toBeUndefined();
    expect(state.dbMessagesMap[key][0].pluginState).toMatchObject({
      askUserAnswers: { Color: ['Red'] },
    });
    expect(state.dbMessagesMap[key][0].pluginIntervention?.status).toBe('approved');
  });

  it('preserves an uncertain check performed by the source resolver without checking again', async () => {
    const { action, state } = createAction();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(messageService.getMessages).mockRejectedValue(new Error('offline'));
    const submit = vi.fn(async () => {
      await action.checkQuestionSubmission(question.id, context);
    });

    await expect(action.runQuestionSubmission(question.id, context, submit)).rejects.toThrow(
      'could not be confirmed',
    );
    expect(state.questionSubmissions.question).toBe('uncertain');
    expect(messageService.getMessages).toHaveBeenCalledOnce();
    await action.runQuestionSubmission(question.id, context, submit);
    expect(submit).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it('keeps an unconfirmed response collapsed until checking succeeds', async () => {
    const { action, state } = createAction();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(messageService.getMessages).mockRejectedValueOnce(new Error('offline'));
    await expect(
      action.runQuestionSubmission(question.id, context, async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');
    expect(state.questionSubmissions.question).toBe('uncertain');
    const submit = vi.fn();
    await action.runQuestionSubmission(question.id, context, submit);
    expect(submit).not.toHaveBeenCalled();
    vi.mocked(messageService.getMessages).mockResolvedValueOnce([question]);
    await action.checkQuestionSubmission(question.id, context);
    expect(state.questionSubmissions.question).toBe('failed');
    log.mockRestore();
  });

  it('does not reopen an accepted answer when connecting its continuation fails', async () => {
    const { action, state } = createAction();
    await expect(
      action.runQuestionSubmission(question.id, context, async () => {
        action.internal_confirmQuestionSubmission(
          question.id,
          { type: 'submit_answers', result: { Color: ['Blue'] } },
          context,
        );
        throw new Error('connection failed');
      }),
    ).rejects.toThrow('connection failed');
    expect(state.questionSubmissions.question).toBeUndefined();
    expect(state.dbMessagesMap[key][0].pluginIntervention?.status).toBe('approved');
    expect(messageService.getMessages).not.toHaveBeenCalled();
  });
});
