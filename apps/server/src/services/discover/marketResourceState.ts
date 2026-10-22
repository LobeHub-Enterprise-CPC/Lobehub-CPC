/**
 * The requester's rights over a Market resource, as Market decided them
 * (`canEdit`, `canUnpublish`). Copied through when present and left out when
 * not: a missing field means "not granted" to the UI in a multi-tenant
 * deployment, and must not turn into an explicit `false` that a later Market
 * version could be mistaken for having answered.
 */
export const pickEditCapabilities = (raw: object) => {
  const { canEdit, canUnpublish } = raw as { canEdit?: unknown; canUnpublish?: unknown };
  return {
    ...(typeof canEdit === 'boolean' ? { canEdit } : {}),
    ...(typeof canUnpublish === 'boolean' ? { canUnpublish } : {}),
  };
};

/**
 * Whether a synced copy still follows the platform (`contentSync`, contract
 * A2): `null` = no local sync binding, `{ detached: false }` = still synced,
 * `{ detached: true }` = cut loose. The three are told apart on purpose, so
 * `null` is kept as `null`, and only `detached` is forwarded: the binding's
 * source and hash are not the browser's business. A response that does not carry
 * a valid state yields no field, never a guessed one.
 */
export const pickContentSync = (raw: object) => {
  const { contentSync } = raw as { contentSync?: unknown };
  if (contentSync === null) return { contentSync: null };
  if (
    typeof contentSync === 'object' &&
    typeof (contentSync as { detached?: unknown }).detached === 'boolean'
  ) {
    return { contentSync: { detached: (contentSync as { detached: boolean }).detached } };
  }
  return {};
};

/** What Market says about a resource beyond its content: the requester's rights and its sync state. */
export const pickMarketResourceState = (raw: object) => ({
  ...pickEditCapabilities(raw),
  ...pickContentSync(raw),
});
