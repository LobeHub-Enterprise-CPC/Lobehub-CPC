/**
 * The desktop client signs in through the organization lookup page too: it opens
 * `/?client=desktop&state=S&code_challenge=C` and the server tells the page how to treat it
 * via `window.__SERVER_CONFIG__.desktopFlow.status`. `state` and `code_challenge` stay in
 * the URL; the page reads and validates them itself and only sends them on with `select`.
 */

export type DesktopFlowStatus = 'expired' | 'invalid' | 'ready' | 'unavailable';

export interface DesktopHandoffParams {
  codeChallenge: string;
  state: string;
}

export type DesktopFlow =
  /** An ordinary visit to the lookup page. */
  | { kind: 'none' }
  /** The request cannot be completed here; the form is hidden and the user restarts from the client. */
  | { kind: 'blocked'; reason: 'expired' | 'invalid' }
  /** Pick an organization for this desktop sign-in. `fastPathUnavailable`: the instant jump failed. */
  | { fastPathUnavailable: boolean; kind: 'active'; params: DesktopHandoffParams };

const STATE_PATTERN = /^[\da-f]{32}$/;
const CODE_CHALLENGE_PATTERN = /^[\w-]{43}$/;
const STATUSES: readonly string[] = ['expired', 'invalid', 'ready', 'unavailable'];

/** `state`: 32 lowercase hex characters; `code_challenge`: 43 base64url characters (S256). */
export const parseDesktopHandoffParams = (search: string): DesktopHandoffParams | null => {
  const query = new URLSearchParams(search);
  const state = query.get('state');
  const codeChallenge = query.get('code_challenge');
  if (!state || !codeChallenge) return null;
  if (!STATE_PATTERN.test(state) || !CODE_CHALLENGE_PATTERN.test(codeChallenge)) return null;
  return { codeChallenge, state };
};

/** The status the server injected, or `null` for a page that is not a desktop sign-in. */
export const readDesktopFlowStatus = (): DesktopFlowStatus | 'unknown' | null => {
  const flow = (window.__SERVER_CONFIG__ as { desktopFlow?: unknown } | undefined)?.desktopFlow;
  if (flow === undefined || flow === null) return null;
  const status = (flow as { status?: unknown }).status;
  return typeof status === 'string' && STATUSES.includes(status)
    ? (status as DesktopFlowStatus)
    : 'unknown';
};

export const resolveDesktopFlow = (
  status: DesktopFlowStatus | 'unknown' | null,
  search: string,
): DesktopFlow => {
  if (status === null) return { kind: 'none' };
  if (status === 'expired') return { kind: 'blocked', reason: 'expired' };
  if (status === 'ready' || status === 'unavailable') {
    const params = parseDesktopHandoffParams(search);
    // Parameters the page cannot vouch for are never sent on, whatever the server said.
    if (!params) return { kind: 'blocked', reason: 'invalid' };
    return { fastPathUnavailable: status === 'unavailable', kind: 'active', params };
  }
  // `invalid`, and anything the page does not recognise, is the safe answer.
  return { kind: 'blocked', reason: 'invalid' };
};

export const readDesktopFlow = (): DesktopFlow =>
  resolveDesktopFlow(readDesktopFlowStatus(), window.location.search);
