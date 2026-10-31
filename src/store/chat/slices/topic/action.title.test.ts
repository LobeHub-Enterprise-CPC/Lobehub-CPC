import type { UIChatMessage } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aiChatService } from '@/services/aiChat';
import { topicService } from '@/services/topic';
import { createServerConfigStore } from '@/store/serverConfig/store';
import { useUserStore } from '@/store/user';
import type { ChatTopic } from '@/types/topic';

import { useChatStore } from '../../store';
import { topicMapKey } from '../../utils/topicMapKey';
import { initialTopicState } from './initialState';
import { topicSelectors } from './selectors';

vi.mock('@/services/topic', () => ({
  topicService: { updateTopic: vi.fn(), getTopicDetail: vi.fn() },
}));
vi.mock('@/services/aiChat', () => ({ aiChatService: { generateJSON: vi.fn() } }));

const serverStore = createServerConfigStore();
const messages = [{ id: 'u1', role: 'user', content: 'Explain replicas' }] as UIChatMessage[];

beforeEach(() => {
  vi.clearAllMocks();
  serverStore.setState({ serverConfigInit: true, serverConfig: { aiProvider: {}, telemetry: {} } });
  useUserStore.setState({ settings: {} });
  useChatStore.setState({ ...initialTopicState, activeAgentId: 'agent', activeTopicId: 'topic' });
  useChatStore.getState().internal_dispatchTopic({
    type: 'addTopic',
    agentId: 'agent',
    value: { id: 'topic', title: '' } as ChatTopic,
  });
  vi.mocked(aiChatService.generateJSON).mockResolvedValue({
    data: { title: 'Replica synchronization' },
  } as never);
});
afterEach(() => vi.restoreAllMocks());

describe('summaryTopicTitle delivery', () => {
  it('updates the sidebar and active header selectors after the first conversation', async () => {
    await useChatStore.getState().summaryTopicTitle('topic', messages);
    expect(topicSelectors.displayTopics(useChatStore.getState())?.[0].title).toBe(
      'Replica synchronization',
    );
    expect(topicSelectors.currentActiveTopic(useChatStore.getState())?.title).toBe(
      'Replica synchronization',
    );
  });

  it('updates a sidebar row loaded while the title is being persisted', async () => {
    useChatStore.setState({ topicDataMap: {} });
    vi.mocked(topicService.getTopicDetail).mockResolvedValue({
      id: 'topic',
      title: '',
    } as ChatTopic);
    vi.mocked(topicService.updateTopic).mockImplementation(async () => {
      useChatStore.getState().internal_dispatchTopic({
        type: 'addTopic',
        agentId: 'agent',
        value: { id: 'topic', title: '' } as ChatTopic,
      });
    });
    await useChatStore.getState().summaryTopicTitle('topic', messages);
    expect(
      useChatStore.getState().topicDataMap[topicMapKey({ agentId: 'agent' })].items[0].title,
    ).toBe('Replica synchronization');
  });

  it('omits loading assistant text from the actual title request', async () => {
    await useChatStore
      .getState()
      .summaryTopicTitle('topic', [
        ...messages,
        { id: 'a1', role: 'assistant', content: '...' } as UIChatMessage,
      ]);
    const request = vi.mocked(aiChatService.generateJSON).mock.calls[0][0];
    expect(request.messages?.[1].content).toContain('Explain replicas');
    expect(request.messages?.[1].content).not.toContain('<assistant>');
  });

  it('waits for server initialization and uses the tenant model even before the bootstrap effect runs', async () => {
    serverStore.setState({ serverConfigInit: false });
    const pending = useChatStore.getState().summaryTopicTitle('topic', messages);
    await Promise.resolve();
    await Promise.resolve();
    expect(aiChatService.generateJSON).not.toHaveBeenCalled();
    serverStore.setState({
      serverConfigInit: true,
      serverConfig: {
        aiProvider: {},
        telemetry: {},
        systemAgent: { topic: { model: 'tenant-title', provider: 'lobehub' } },
      },
    });
    await pending;
    expect(aiChatService.generateJSON).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'tenant-title', provider: 'lobehub' }),
      expect.any(AbortController),
    );
  });
});

it('retains an explicit user title model over the initialized tenant default', async () => {
  serverStore.setState({
    serverConfig: {
      aiProvider: {},
      telemetry: {},
      systemAgent: { topic: { model: 'tenant-title', provider: 'lobehub' } },
    },
  });
  useUserStore.setState({
    settings: { systemAgent: { topic: { model: 'user-title', provider: 'openai' } } },
  });
  await useChatStore.getState().summaryTopicTitle('topic', messages);
  expect(aiChatService.generateJSON).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'user-title', provider: 'openai' }),
    expect.any(AbortController),
  );
});
