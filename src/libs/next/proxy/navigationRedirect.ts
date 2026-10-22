import { escapeAttribute } from 'entities';

/**
 * Navigations that must discard the visitor's inherited URL context (the discovery policy's
 * `/?switch=1#`, `/#`, the remembered organization's session entry `/__entry#` and the
 * organization root it answers with, a desktop authorize URL) end their target with an empty
 * fragment: a 3xx without one makes the browser carry the old fragment over.
 *
 * Next cannot deliver that from a 3xx in the proxy: it rebuilds the `Location` twice and both
 * steps drop an empty `#`. So the proxy answers 200 with a page whose `<meta http-equiv=refresh>`
 * navigates to the target; a navigation started from a document never inherits a fragment, and
 * the page needs no script. The answer carries no secret and no state, so there is nothing to
 * sign: the target is chosen by the proxy from the directory or the platform URL, never from the
 * request, and is validated here again.
 */

/** Absolute http(s) target without credentials whose last character is the empty fragment. */
const isFragmentClearingTarget = (value: string) => {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.href === value &&
      value.endsWith('#') &&
      url.hash === ''
    );
  } catch {
    return false;
  }
};

const NO_STORE = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };

/**
 * Fails closed: an unacceptable target is a 503 without any way forward, never a plain 3xx that
 * Next would rebuild without its empty `#`.
 */
export const navigationRedirect = (location: string) => {
  if (!isFragmentClearingTarget(location))
    return new Response(null, { headers: NO_STORE, status: 503 });
  const target = escapeAttribute(location);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title></title></head><body><a href="${target}">${target}</a></body></html>`,
    { headers: { ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8' }, status: 200 },
  );
};
