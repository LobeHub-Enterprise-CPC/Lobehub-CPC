import {
  BRANDING_NAME,
  BUILTIN_TOOL_DISPLAY_IDENTIFIERS,
  BUILTIN_TOOL_DISPLAY_NAMESPACE,
} from '@lobechat/business-const';

/**
 * Builtin tools and skills are identified as `lobe-<name>`: the canonical
 * namespace that `ToolNameResolver` in context-engine rewrites for the model.
 */
const BUILTIN_TOOL_ID_PREFIX = 'lobe-';

/** The builtin LobeHub skill (`LobeHubIdentifier` in builtin-skills). */
const LOBEHUB_SKILL_IDENTIFIER = 'lobehub';

/**
 * The tool identifier to show people. Presentation only: persisted plugin
 * lists, uninstall settings, Market agent configs and the tool names sent to
 * the model all keep the runtime identifier.
 *
 * In order: an explicit `BUILTIN_TOOL_DISPLAY_IDENTIFIERS` entry; the LobeHub
 * skill as the brand name; the `lobe-` prefix replaced by
 * `BUILTIN_TOOL_DISPLAY_NAMESPACE` when a distribution sets one. Anything else
 * is shown as is.
 */
export const getToolDisplayIdentifier = (identifier: string): string => {
  // Own keys only, so an identifier such as `constructor` never resolves to a prototype member.
  if (Object.hasOwn(BUILTIN_TOOL_DISPLAY_IDENTIFIERS, identifier))
    return BUILTIN_TOOL_DISPLAY_IDENTIFIERS[identifier];

  if (identifier === LOBEHUB_SKILL_IDENTIFIER)
    return BRANDING_NAME.toLowerCase().replaceAll(/\s+/g, '');

  if (BUILTIN_TOOL_DISPLAY_NAMESPACE && identifier.startsWith(BUILTIN_TOOL_ID_PREFIX))
    return `${BUILTIN_TOOL_DISPLAY_NAMESPACE}-${identifier.slice(BUILTIN_TOOL_ID_PREFIX.length)}`;

  return identifier;
};

/**
 * Text shown to people that quotes builtin identifiers, such as a builtin
 * skill's instructions in its detail panel: `lobe-<name>` IDs show as their
 * display identifier, and the `lobe` namespace of protocol names
 * (`<lobeArtifact>`, `application/lobe.artifacts.react`) as
 * `BUILTIN_TOOL_DISPLAY_NAMESPACE`. Presentation only: the model still receives
 * the original text. Unchanged when the distribution sets no namespace.
 */
export const getToolDisplayText = (text: string): string => {
  if (!BUILTIN_TOOL_DISPLAY_NAMESPACE) return text;

  return text.replaceAll(/(?<![\w-])lobe(?:(?:-[\da-z]+)+|(?=[.A-Z]))/g, (match) =>
    match === 'lobe' ? BUILTIN_TOOL_DISPLAY_NAMESPACE : getToolDisplayIdentifier(match),
  );
};
