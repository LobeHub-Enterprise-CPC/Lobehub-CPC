import { describe, expect, it } from 'vitest';

import { changeNodeAccessMode, isNodeAccessDirty } from './nodeAccessDraft';

const inherited = [
  {
    principalType: 'user' as const,
    principalId: 'member',
    name: 'Member',
    memberCount: null,
    deleted: false,
    accessLevel: 'view' as const,
  },
];
const saved = { mode: 'inherit' as const, grants: inherited, version: 0 };
describe('node access draft', () => {
  it('switches to custom using the effective inherited list and requires saving even when unchanged', () => {
    const draft = changeNodeAccessMode(saved, 'custom', inherited);
    expect(draft.grants).toEqual(inherited);
    expect(isNodeAccessDirty(saved, draft)).toBe(true);
  });
  it('displays the parent list when returning to inherit, and preserves the optimistic lock', () => {
    const custom = { mode: 'custom' as const, version: 4, grants: [] };
    const draft = changeNodeAccessMode(custom, 'inherit', inherited);
    expect(draft).toEqual({ mode: 'inherit', version: 4, grants: inherited });
    expect(isNodeAccessDirty(custom, draft)).toBe(true);
    expect(changeNodeAccessMode(draft, 'custom', inherited).grants).toEqual(inherited);
  });
  it('ignores ordering, but detects empty custom policies and changed levels', () => {
    const second = { ...inherited[0], principalId: 'second' };
    const custom = { mode: 'custom' as const, version: 2, grants: [...inherited, second] };
    expect(isNodeAccessDirty(custom, { ...custom, grants: [second, ...inherited] })).toBe(false);
    expect(isNodeAccessDirty(custom, { ...custom, grants: [] })).toBe(true);
    expect(
      isNodeAccessDirty(custom, { ...custom, grants: [{ ...second, accessLevel: 'edit' }] }),
    ).toBe(true);
  });
  it('returning to the saved inherited mode cancels the draft without treating parent refreshes as writes', () => {
    expect(isNodeAccessDirty(saved, { ...saved, grants: [] })).toBe(false);
  });
});
