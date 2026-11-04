import { describe, expect, it } from 'vitest';

import { builderSuggestionKey } from './projection';

const base = {
  builderAgentId: 'builder',
  locale: 'zh-CN',
  mode: 'agent',
  targetId: 'agt_1',
} as const;

describe('builderSuggestionKey', () => {
  it('misses after a rename, because the chips quote the old name', () => {
    expect(builderSuggestionKey({ ...base, targetName: '明月' })).not.toBe(
      builderSuggestionKey({ ...base, targetName: '设计验收-助理' }),
    );
  });

  it('stays stable for the same name, so autosaves do not regenerate', () => {
    expect(builderSuggestionKey({ ...base, targetName: '明月' })).toBe(
      builderSuggestionKey({ ...base, targetName: '明月' }),
    );
  });
});
