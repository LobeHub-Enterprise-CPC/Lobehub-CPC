/** Server-only opt-in. Never expose the Docker/internal URL to the browser. */
export function getChannelGatewayUrl(): URL | undefined {
  const value = process.env.CHANNEL_GATEWAY_URL?.trim();
  if (!value) return;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    url.pathname = `${url.pathname.replace(/\/$/, '')}/`;
    return url;
  } catch {
    return;
  }
}

/** Do not accept work when the configured coordinator cannot consume it. */
export async function isChannelGatewayReady(): Promise<boolean> {
  const gateway = getChannelGatewayUrl();
  if (!gateway) return false;
  try {
    const response = await fetch(new URL('healthz', gateway), {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body.status === 'ready';
  } catch {
    return false;
  }
}
