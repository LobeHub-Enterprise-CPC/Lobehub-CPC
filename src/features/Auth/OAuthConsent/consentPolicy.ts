/**
 * First-party clients whose consent is given on the user's behalf, without a page to read.
 *
 * The desktop client is deliberately not here: its sign-in can arrive at this page straight
 * from a remembered organization, and the person at the browser must be the one who started
 * it from their own desktop app, so it shows the consent page with that notice.
 */
const AUTO_APPROVED_CLIENTS: ReadonlySet<string> = new Set(['lobehub-mobile', 'lobehub-market']);

export const isAutoApprovedClient = (clientId: string): boolean =>
  AUTO_APPROVED_CLIENTS.has(clientId);
