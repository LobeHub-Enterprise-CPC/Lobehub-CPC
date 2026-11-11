import type { KnowledgeBaseItem } from '@lobechat/types';

/** Enterprise grants replace workspace role checks; ordinary libraries retain them. */
export const getKnowledgeBaseCapabilities = (
  item: Pick<KnowledgeBaseItem, 'enterprise' | 'accessRevoked'> | undefined,
  roleAllowed = true,
  nodeLevel?: 'owner' | 'edit' | 'view' | 'path' | null,
) => {
  const enterprise = !!item?.enterprise || !!item?.accessRevoked;
  const level = item?.accessRevoked ? undefined : item?.enterprise?.accessLevel;
  const contentLevel = item?.accessRevoked
    ? undefined
    : nodeLevel === undefined
      ? level
      : nodeLevel;
  return {
    canEditContent: enterprise ? contentLevel === 'owner' || contentLevel === 'edit' : roleAllowed,
    canManageAccess: enterprise ? level === 'owner' : roleAllowed,
    canManageInfo: enterprise ? level === 'owner' : roleAllowed,
    canRemoveLibrary: !enterprise && roleAllowed,
    canTransfer: !enterprise && roleAllowed,
    enterprise,
  };
};
