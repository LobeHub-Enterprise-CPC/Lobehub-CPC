import { ActivatorApiName, LobeActivatorIdentifier } from '@lobechat/builtin-tool-activator';
import { SkillsIdentifier } from '@lobechat/builtin-tool-skills';
import { resolveShareToolGrants, type ShareToolGrant } from '@lobechat/const';

import type { ShareDataToolPermissions } from './types';

export const hasShareSkillAuthorization = (permissions: ShareDataToolPermissions): boolean =>
  (permissions.skillGrants?.length ?? 0) > 0;

export const resolveEffectiveShareToolGrants = (
  permissions: ShareDataToolPermissions,
): Map<string, ShareToolGrant> => {
  const grants = resolveShareToolGrants(permissions.toolGrants);

  grants.delete(LobeActivatorIdentifier);
  if (grants.size > 0) {
    grants.set(LobeActivatorIdentifier, new Set([ActivatorApiName.activateTools]));
  }

  if (hasShareSkillAuthorization(permissions)) grants.set(SkillsIdentifier, 'all');

  return grants;
};
