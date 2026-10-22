/**
 * ComfyUI endpoint trust
 *
 * The ComfyUI base URL arrives from the user's provider settings (and straight
 * from the tRPC input), so it is untrusted unless it is the server the platform
 * itself configured (COMFYUI_BASE_URL / COMFYUI_DEFAULT_URL) or absent (the
 * built-in default). Untrusted endpoints are reached only through
 * connect-time-filtered transports; platform endpoints keep the plain ones.
 */
import { createSsrfSafeAgents, createSsrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import { ComfyApi } from '@saintno/comfyui-sdk';
import WebSocket from 'ws';

const normalizeEndpoint = (url: string) => {
  try {
    return new URL(url.trim()).href.replace(/\/+$/, '');
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
};

export const isPlatformComfyUIEndpoint = (baseURL?: string): boolean => {
  if (!baseURL) return true;

  const configured = [process.env.COMFYUI_BASE_URL, process.env.COMFYUI_DEFAULT_URL]
    .filter((url): url is string => !!url)
    .map(normalizeEndpoint);

  return configured.includes(normalizeEndpoint(baseURL));
};

/** WebSocket whose TCP connection goes through the connect-time IP filter. */
class SafeWebSocket extends WebSocket {
  constructor(address: string | URL, options?: any) {
    const { httpAgent, httpsAgent } = createSsrfSafeAgents();
    const isSecure = String(address).startsWith('wss:');
    super(address, { ...options, agent: isSecure ? httpsAgent : httpAgent });
  }
}

type ComfyApiOptions = ConstructorParameters<typeof ComfyApi>[2];

/**
 * ComfyApi whose HTTP calls and WebSocket both pass the connect-time IP filter.
 * The SDK calls the global `fetch` and `ws` directly, so both are overridden.
 */
export class SafeComfyApi extends ComfyApi {
  private readonly safeFetch = createSsrfSafeFetch();

  constructor(host: string, clientId?: string, opts?: ComfyApiOptions) {
    super(host, clientId, { ...opts, customWebSocketImpl: SafeWebSocket as any });
  }

  override async fetchApi(route: string, options: any = {}): Promise<Response> {
    const self = this as unknown as {
      apiURL: (route: string) => string;
      getCredentialHeaders: () => Record<string, string>;
    };
    options.headers = { ...self.getCredentialHeaders() };
    options.mode = 'cors';

    return this.safeFetch(self.apiURL(route), options);
  }
}
