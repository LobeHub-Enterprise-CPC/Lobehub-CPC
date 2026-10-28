/** The first-party desktop app: signs in through the server login bridge and always consents explicitly. */
export const DESKTOP_CLIENT_ID = 'tituwork-desktop';

/**
 * Desktop client ids this deployment no longer registers.
 *
 * Renaming the desktop client leaves every installed app holding tokens issued to
 * the old id. They still verify (same keys, same audience), so the app keeps
 * looking signed in while services that check the client — the agent gateway —
 * answer UNAUTHORIZED, and nothing tells the user to sign in again. Rejecting
 * them as unauthenticated makes the API send X-Auth-Required, which the desktop
 * turns into its "session expired, sign in" prompt.
 */
export const RETIRED_DESKTOP_CLIENT_IDS: ReadonlySet<string> = new Set(
  ['lobehub-desktop'].filter((id) => id !== DESKTOP_CLIENT_ID),
);
