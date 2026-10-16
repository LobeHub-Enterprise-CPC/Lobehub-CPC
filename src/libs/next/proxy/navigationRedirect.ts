import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

/**
 * 302 responses that must discard the visitor's inherited URL context (the discovery policy's
 * `/?switch=1#`, `/#`, the remembered organization's session entry `/__entry#` and the
 * organization root it answers with, a desktop authorize URL) end their `Location`
 * with an empty fragment: a redirect without one makes the browser carry the old fragment over.
 *
 * Next cannot deliver that from the proxy. It rebuilds a proxy `Location` twice, through
 * `NextURL` in the proxy adapter and through `url.format` in the router server, and both drop an
 * empty `#`; neither step is configurable (`skipProxyUrlNormalize` only removes the first). A
 * route handler's response is sent unchanged, so the proxy rewrites to the handler below and
 * hands the target over in a request header. Same trust model as `x-lobe-tenant-route`: the
 * proxy strips any client copy first, and the value is a MAC under a key derived from
 * `KEY_VAULTS_SECRET`, so reaching the handler without the proxy cannot make it redirect.
 */
export const NAVIGATION_REDIRECT_HEADER = 'x-lobe-navigation-redirect';
export const NAVIGATION_REDIRECT_PATH = '/api/internal/navigation-redirect';

/**
 * Upper bound for the signed header, on both sides. The value is internal request data (HMAC gives
 * integrity, not confidentiality; the target may be a desktop authorization URL): it is never
 * logged or echoed, and the proxy's request-header overrides are stripped before the response
 * leaves Next. Real targets are a few hundred bytes.
 */
export const MAX_NAVIGATION_REDIRECT_HEADER_LENGTH = 8192;

const KEY_INFO = 'lobehub:navigation-redirect';
const NOT_FOUND = () => new Response(null, { status: 404 });

const key = () => {
  const secret = process.env.KEY_VAULTS_SECRET;
  if (!secret) return null;
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(KEY_INFO), 32),
  );
};

const mac = (macKey: Buffer, payload: string) =>
  createHmac('sha256', macKey).update(payload, 'utf8').digest('base64url');

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

/** `<base64url target>.<mac>`, or `null` for an unacceptable target or a missing secret. */
export const signNavigationRedirect = (location: string): string | null => {
  const macKey = key();
  if (!macKey) return null;
  let href: string;
  try {
    href = new URL(location).href;
  } catch {
    return null;
  }
  if (!isFragmentClearingTarget(href) || !location.endsWith('#')) return null;
  const payload = Buffer.from(href, 'utf8').toString('base64url');
  const signed = `${payload}.${mac(macKey, payload)}`;
  return signed.length <= MAX_NAVIGATION_REDIRECT_HEADER_LENGTH ? signed : null;
};

const verifyNavigationRedirect = (value: string | null): string | null => {
  const macKey = key();
  if (!macKey || !value || value.length > MAX_NAVIGATION_REDIRECT_HEADER_LENGTH) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'utf8');
  const expected = Buffer.from(mac(macKey, payload), 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const target = Buffer.from(payload, 'base64url').toString('utf8');
  return isFragmentClearingTarget(target) ? target : null;
};

/** Route handler behind `NAVIGATION_REDIRECT_PATH`. */
export const handleNavigationRedirect = (request: Request): Response => {
  const target = verifyNavigationRedirect(request.headers.get(NAVIGATION_REDIRECT_HEADER));
  if (!target) return NOT_FOUND();
  return new Response(null, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Location': target,
      'Referrer-Policy': 'no-referrer',
    },
    status: 302,
  });
};

/**
 * The proxy's answer for such a redirect. `headers` are the already-sanitised request headers.
 * Fails closed: if the target cannot be signed (no `KEY_VAULTS_SECRET`, which tenant routing
 * needs anyway, or an unacceptable target) the answer is a 503 without any `Location`. A plain
 * 3xx from the proxy would be rebuilt by Next without its empty `#`, silently keeping the
 * fragment the redirect exists to discard.
 */
export const navigationRedirect = (request: Request, headers: Headers, location: string) => {
  const signed = signNavigationRedirect(location);
  if (!signed)
    return new Response(null, {
      headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
      status: 503,
    });
  const routed = new Headers(headers);
  routed.set(NAVIGATION_REDIRECT_HEADER, signed);
  const url = new URL(request.url);
  url.pathname = NAVIGATION_REDIRECT_PATH;
  url.search = '';
  return NextResponse.rewrite(url, { request: { headers: routed } });
};
