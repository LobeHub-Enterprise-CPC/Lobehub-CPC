import {
  AGENT_SHARE_ALLOWED_BUILTIN_IDENTIFIERS,
  isBuiltinToolIdentifier,
} from '@lobechat/builtin-tools';

/**
 * See `AGENT_SHARE_ALLOWED_BUILTIN_IDENTIFIERS`'s JSDoc in
 * `@lobechat/builtin-tools` for the full per-identifier evidence. Aliased here
 * so the two enforcement points below read as one local rule.
 */
export const SHARE_VISITOR_ALLOWED_IDENTIFIERS = AGENT_SHARE_ALLOWED_BUILTIN_IDENTIFIERS;

export const isGovernedByBuiltinAllowlist = isBuiltinToolIdentifier;
