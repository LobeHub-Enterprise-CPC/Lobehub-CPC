import { describe, expect, it } from 'vitest';

import { channelMentionIds } from './mentions';

const chip = (id: string) => ({ type: 'mention', metadata: { type: 'channel-member', id } });
describe('Channel recipient chips', () => {
  it('selects only real active member chips, not text, code, foreign IDs or another mention kind', () => {
    expect(
      channelMentionIds(
        {
          root: {
            children: [
              { type: 'text', text: '@B @all' },
              chip('A'),
              chip('A'),
              chip('foreign'),
              { type: 'code', children: [chip('B')] },
              { type: 'mention', metadata: { type: 'agent', id: 'B' } },
            ],
          },
        },
        ['A', 'B'],
      ),
    ).toEqual(['A']);
  });
  it('reflects chip removal rather than retaining a previous recipient', () => {
    expect(channelMentionIds({ root: { children: [chip('B')] } }, ['A', 'B'])).toEqual(['B']);
    expect(channelMentionIds({ root: { children: [] } }, ['A', 'B'])).toEqual([]);
  });
});
