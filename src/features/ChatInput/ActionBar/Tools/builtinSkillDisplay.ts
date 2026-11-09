import { LobeHubIdentifier } from '@lobechat/builtin-skills/manifests';
import { BRANDING_NAME, BUILTIN_SKILL_DISPLAY_IDENTIFIERS } from '@lobechat/business-const';

// Presentation only: persisted identifiers and runtime names must stay unchanged.
export const getBuiltinSkillDisplayIdentifier = (identifier: string): string => {
  // Own keys only, so an identifier such as `constructor` never resolves to a prototype member.
  if (Object.hasOwn(BUILTIN_SKILL_DISPLAY_IDENTIFIERS, identifier))
    return BUILTIN_SKILL_DISPLAY_IDENTIFIERS[identifier];

  return identifier === LobeHubIdentifier
    ? BRANDING_NAME.toLowerCase().replaceAll(/\s+/g, '')
    : identifier;
};
