import type { UIChatMessage } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { normalizeTopicTitleMessages } from './topicTitle';

describe('normalizeTopicTitleMessages', () => {
  it('removes loading assistant placeholders while preserving user text and completed replies', () => {
    const messages = [
      { id: 'user', role: 'user', content: '...' },
      { id: 'loading', role: 'assistant', content: ' ... ' },
      { id: 'reply', role: 'assistant', content: 'Complete answer' },
    ] as UIChatMessage[];
    expect(normalizeTopicTitleMessages(messages)).toEqual([messages[0], messages[2]]);
  });

  it.each(['assistantGroup', 'supervisor'] as const)('omits a loading %s wrapper', (role) => {
    expect(
      normalizeTopicTitleMessages([{ id: 'loading', role, content: '...' } as UIChatMessage]),
    ).toEqual([]);
  });

  it('can summarize a user-only conversation', () => {
    const messages = [{ id: 'user', role: 'user', content: 'Explain replicas' }] as UIChatMessage[];
    expect(normalizeTopicTitleMessages(messages)).toEqual(messages);
  });
});
