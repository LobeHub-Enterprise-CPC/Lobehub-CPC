import type { KnowledgeBaseItem } from '@lobechat/types';

/** Enterprise grants replace workspace role checks; ordinary libraries retain them. */
export const getKnowledgeBaseCapabilities = (
  item: Pick<KnowledgeBaseItem, 'enterprise' | 'accessRevoked'> | undefined,
  roleAllowed = true,
) => {
  const enterprise = !!item?.enterprise || !!item?.accessRevoked;
  const level = item?.accessRevoked ? undefined : item?.enterprise?.accessLevel;
  return {
    canEditContent: enterprise ? level === 'owner' || level === 'edit' : roleAllowed,
    canManageAccess: enterprise ? level === 'owner' : roleAllowed,
    canManageInfo: enterprise ? level === 'owner' : roleAllowed,
    canRemoveLibrary: !enterprise && roleAllowed,
    canTransfer: !enterprise && roleAllowed,
    enterprise,
  };
};
