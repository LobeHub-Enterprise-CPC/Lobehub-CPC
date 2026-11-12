import isEqual from 'fast-deep-equal';

import type { EnterpriseKbGrant, EnterpriseKbGrantInput } from '@/services/enterpriseKnowledge';

export interface NodeAccessDraft {
  grants: EnterpriseKbGrant[];
  mode: 'custom' | 'inherit';
  version: number;
}
export const grantInputs = (grants: EnterpriseKbGrant[]): EnterpriseKbGrantInput[] =>
  grants.map(({ principalId, principalType, accessLevel }) => ({
    principalId,
    principalType,
    accessLevel,
  }));
const canonical = (grants: EnterpriseKbGrant[]) =>
  grantInputs(grants).sort(
    (a, b) =>
      a.principalType.localeCompare(b.principalType) || a.principalId.localeCompare(b.principalId),
  );

export const isNodeAccessDirty = (saved: NodeAccessDraft, draft: NodeAccessDraft) =>
  saved.mode !== draft.mode ||
  (draft.mode === 'custom' && !isEqual(canonical(saved.grants), canonical(draft.grants)));

export const changeNodeAccessMode = (
  current: NodeAccessDraft,
  mode: NodeAccessDraft['mode'],
  inherited: EnterpriseKbGrant[],
): NodeAccessDraft => ({
  grants: mode === 'inherit' || current.mode === 'inherit' ? inherited : current.grants,
  mode,
  version: current.version,
});
