/**
 * A fresh id for one client-side execution (a tool invocation, an install, a
 * click). Made once where the execution starts and carried with everything that
 * reports it, so a transport retry of the report is the same event while the
 * next invocation is a different one.
 */
export const newClientExecutionId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;

  // No Web Crypto (an old webview): collision-resistant enough for one user's
  // own actions, and never reused within the process.
  return `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
};
