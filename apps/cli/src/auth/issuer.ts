/** Canonical `origin + path` of a server address, or `undefined` when it is not a URL. */
const canonicalServerUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
};

/**
 * Whether two server addresses are the same server. The tenant path is part of the identity
 * (`https://host/t/a` and `https://host/t/b` are different organizations on one host), so a
 * bare origin comparison would let one tenant's credential reach another.
 */
export const sameServerUrl = (a: string, b: string | undefined): boolean => {
  const left = canonicalServerUrl(a);
  return left !== undefined && b !== undefined && left === canonicalServerUrl(b);
};
