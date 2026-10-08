import { LobeHubIdentifier } from '@lobechat/builtin-skills/manifests';
import { BRANDING_NAME } from '@lobechat/business-const';

// Presentation only: persisted identifiers and runtime names must stay unchanged.
export const getBuiltinSkillDisplayIdentifier = (identifier: string): string =>
  identifier === LobeHubIdentifier
    ? BRANDING_NAME.toLowerCase().replaceAll(/\s+/g, '')
    : identifier;
