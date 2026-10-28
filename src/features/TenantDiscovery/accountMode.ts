/**
 * Whether the root page should show the remembered-account confirm card instead of the
 * organization finder form.
 *
 * The server marks an account-mode document with `window.__SERVER_CONFIG__.rootAccount === true`
 * (a presentation-only flag, the same way the desktop-flow status reaches the page; the type
 * field itself is added by the server-side package). Account mode never applies to a desktop
 * sign-in: that request is finished inside the desktop client.
 */

import { type DesktopFlow, readDesktopFlow } from './desktopFlow';

/** The presentation-only flag the server injects for an account-mode document. */
export const readRootAccountFlag = (): boolean => window.__SERVER_CONFIG__?.rootAccount === true;

/**
 * Account mode, fixed for the life of the page: the request that opened it does not change.
 * Pass an explicit flow in tests to avoid reading the URL.
 */
export const resolveAccountMode = (rootAccount: boolean, desktopFlow: DesktopFlow): boolean =>
  rootAccount && desktopFlow.kind === 'none';

export const readAccountMode = (desktopFlow?: DesktopFlow): boolean =>
  resolveAccountMode(readRootAccountFlag(), desktopFlow ?? readDesktopFlow());
