import type { NextRequest } from 'next/server';

/**
 * The URL a request is routed by, with its origin taken from the `Host` header alone — validated
 * as one complete authority — and never from forwarded headers. `null` when the authority is
 * malformed.
 *
 * Next's URL can retain its deployment origin. `URL.host` assignment does not clear an omitted
 * port and silently ignores malformed ports, so hostname and port are assigned explicitly.
 * Configured public/internal protocols normalize their default ports; custom entries are always
 * HTTPS.
 */
export const requestUrlByHost = (
  req: NextRequest,
  hosts: { appUrl: string; internalUrl: string },
): URL | null => {
  const requestUrl = new URL(req.url);
  const actualHost = req.headers.get('host');
  if (!actualHost) return requestUrl;
  const authority = /^(?:\[[\da-f:.]+\]|[a-z\d.-]+)(?::(\d{1,5}))?$/i.exec(actualHost);
  if (!authority) return null;
  let parsed: URL;
  try {
    parsed = new URL(`http://${actualHost}`);
  } catch {
    return null;
  }
  const origin = [new URL(hosts.appUrl), new URL(hosts.internalUrl)].find(
    (candidate) => candidate.hostname === parsed.hostname,
  );
  requestUrl.protocol = origin?.protocol ?? 'https:';
  requestUrl.hostname = parsed.hostname;
  requestUrl.port = authority[1] === undefined ? '' : String(Number(authority[1]));
  return requestUrl;
};
