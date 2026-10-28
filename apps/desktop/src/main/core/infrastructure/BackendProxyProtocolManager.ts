import { AUTH_FAILURE_HEADER, AUTH_REQUIRED_HEADER } from '@lobechat/desktop-bridge';
import { buildRemoteUrl, isUnderRemoteBase } from '@lobechat/utils/remoteUrl';
import { BrowserWindow, type Session, session as electronSession } from 'electron';

import { isDev } from '@/const/env';
import { isBackendPath, isSandboxedBackendRequestAllowed } from '@/const/protocol';
import { getDesktopEnv } from '@/env';
import { appendVercelCookie } from '@/utils/http-headers';
import { describeJwtClaims } from '@/utils/jwt-claims';
import { createLogger } from '@/utils/logger';
import { netFetch } from '@/utils/net-fetch';
import { classifyProxyNetworkError } from '@/utils/proxy-network-error';
import { setDesktopUserAgentHeader } from '@/utils/user-agent';

import type { RendererRequestInterceptor } from './RendererProtocolManager';

interface BackendProxyContext {
  getAccessToken: () => Promise<string | undefined | null>;
  /** The server answered 409 TENANT_ENDPOINT_CHANGED: the entry must be resolved again. */
  onEndpointChanged?: () => void;
  rewriteUrl: (rawUrl: string) => Promise<string | null>;
  source?: string;
}

interface BackendProxyRemoteBaseOptions {
  getAccessToken: () => Promise<string | undefined | null>;
  getRemoteBaseUrl: () => Promise<string | undefined | null>;
  onEndpointChanged?: () => void;
  source?: string;
}

/**
 * Holds per-session proxy context for routing renderer-originated backend
 * requests (`/trpc`, `/webapi`, `/api/auth`, `/market`) to the remote LobeHub
 * server. The context is consumed by `createAppRequestInterceptor`, which the
 * `app://` protocol manager invokes before its static / Vite fallback.
 */
const describeError = (error: unknown) => {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
};

/**
 * Serialize a network-level proxy failure as the JSON `ErrorResponse` envelope
 * (`{ body, errorType }`) the renderer's error chain already parses — a plain
 * 502 is indistinguishable from a real server-side 502, and users read that as
 * an app bug when it is almost always their own network/proxy/VPN.
 */
const proxyNetworkErrorBody = (reason: string, url?: string) =>
  JSON.stringify({
    body: { detail: reason, ...(url ? { url } : {}) },
    errorType: classifyProxyNetworkError(reason),
  });

/**
 * What the renderer gets for a backend call while the session has no remote server (cloud
 * mode before sign-in: the platform origin is never a fallback for business requests). It is
 * the same answer the server gives an unauthenticated call, so every client-side error chain
 * already knows it, instead of a plain-text 502 that fails JSON parsing on every call.
 *
 * Deliberately without `X-Auth-Required`: that header (and the `authorizationRequired`
 * broadcast it drives) means "your session expired, sign in again". Nobody has signed in
 * yet here, and the desktop renderer does not redirect on a plain 401.
 */
const notSignedInResponse = (pathname: string) => {
  const message = 'Not signed in to an organization yet';
  const isTrpc = pathname === '/trpc' || pathname.startsWith('/trpc/');

  // tRPC (superjson transformer): a bare error object is applied by the batch link to every
  // operation of the batch, so the same body serves batched and single calls.
  const body = isTrpc
    ? {
        error: {
          json: { code: -32_001, data: { code: 'UNAUTHORIZED', httpStatus: 401 }, message },
        },
      }
    : // `ChatErrorType.Unauthorized` (= 401) in the app's `ErrorResponse` envelope.
      { body: { detail: message }, errorType: 401 };

  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status: 401,
    statusText: 'Unauthorized',
  });
};

export class BackendProxyProtocolManager {
  private readonly contexts = new WeakMap<Session, BackendProxyContext>();
  private readonly logger = createLogger('core:BackendProxyProtocolManager');

  private authRequiredDebounceTimer: NodeJS.Timeout | null = null;
  private pendingAuthRequiredReason: string | null = null;
  private surfacedUncaughtProxyError = false;
  private static readonly AUTH_REQUIRED_DEBOUNCE_MS = 1000;

  /** Upstream requests awaiting response headers. */
  private pendingUpstream = 0;
  /**
   * Upstream responses whose body is still streaming. Each one holds a socket
   * in the default session's pool, and `net.fetch` inside `protocol.handle` is
   * downgraded to HTTP/1.1 (electron#46828) — so the pool caps out at 6 per
   * host. A body that never closes never gives its socket back, which is what a
   * "every backend call 502s until restart" failure looks like from the outside.
   */
  private openUpstreamBodies = 0;

  /**
   * Wrap an upstream body so the gauge drops when the stream ends — whether it
   * completes, errors, or the renderer cancels it.
   */
  private trackUpstreamBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    this.openUpstreamBodies += 1;

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.openUpstreamBodies -= 1;
    };

    return new ReadableStream<Uint8Array>({
      cancel: (reason) => {
        release();
        return reader.cancel(reason);
      },
      pull: async (controller) => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            release();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          release();
          controller.error(error);
        }
      },
    });
  }

  private shouldRethrowProxyErrors() {
    return isDev && getDesktopEnv().DESKTOP_BACKEND_PROXY_RETHROW_ERRORS;
  }

  private surfaceUncaughtProxyError(error: unknown) {
    if (!this.shouldRethrowProxyErrors() || this.surfacedUncaughtProxyError) return;

    this.surfacedUncaughtProxyError = true;
    setTimeout(() => {
      throw error;
    }, 0);
  }

  private notifyAuthorizationRequired(reason: string) {
    // Trailing-edge debounce: coalesce rapid 401 bursts and fire AFTER the burst settles.
    // This ensures the IPC event is sent after the renderer has had time to mount listeners.
    // The most recent reason wins — within a burst they almost always describe the same cause.
    this.pendingAuthRequiredReason = reason;

    if (this.authRequiredDebounceTimer) {
      clearTimeout(this.authRequiredDebounceTimer);
    }

    this.authRequiredDebounceTimer = setTimeout(() => {
      this.authRequiredDebounceTimer = null;
      const finalReason = this.pendingAuthRequiredReason ?? reason;
      this.pendingAuthRequiredReason = null;

      this.logger.info(`Broadcasting authorizationRequired (reason=${finalReason})`);

      const allWindows = BrowserWindow.getAllWindows();
      for (const win of allWindows) {
        if (!win.isDestroyed()) {
          win.webContents.send('authorizationRequired', { reason: finalReason });
        }
      }
    }, BackendProxyProtocolManager.AUTH_REQUIRED_DEBOUNCE_MS);
  }

  /**
   * Bind a session's proxy context using a remote-base-URL provider. Backend
   * paths get rewritten onto the remote base; same-origin requests pass through
   * (returns null so the `app://` handler falls back to its static / Vite path).
   */
  registerWithRemoteBaseUrl(session: Session, options: BackendProxyRemoteBaseOptions) {
    let lastRemoteBaseUrl: string | undefined;

    const rewriteUrl = async (rawUrl: string) => {
      lastRemoteBaseUrl = undefined;
      try {
        const requestUrl = new URL(rawUrl);

        const remoteBaseUrl = await options.getRemoteBaseUrl();
        if (!remoteBaseUrl) return null;
        lastRemoteBaseUrl = remoteBaseUrl;

        // The remote base may carry a tenant path prefix (`https://host/orgs/acme`) that the
        // renderer's backend paths (`/trpc/...`) do not, so the path is mounted under it.
        const remoteBase = new URL(remoteBaseUrl);
        // A same-origin request already under the base path is addressed to the tenant
        // as is: leave it alone. A same-origin request outside the base path (the bare
        // `/trpc` of a prefixed base) is still a tenant request missing its prefix.
        if (
          requestUrl.origin === remoteBase.origin &&
          isUnderRemoteBase(requestUrl.pathname, remoteBase)
        ) {
          return null;
        }

        const rewrittenUrl = buildRemoteUrl(
          requestUrl.pathname + requestUrl.search,
          remoteBase,
        ).toString();
        this.logger.debug(
          `${options.source ? `[${options.source}] ` : ''}BackendProxy rewrite ${rawUrl} -> ${rewrittenUrl}`,
        );
        return rewrittenUrl;
      } catch (error) {
        this.logger.error(
          `${options.source ? `[${options.source}] ` : ''}BackendProxy rewriteUrl error (rawUrl=${rawUrl}, remoteBaseUrl=${lastRemoteBaseUrl})`,
          error,
        );
        return null;
      }
    };

    this.register(session, {
      getAccessToken: options.getAccessToken,
      onEndpointChanged: options.onEndpointChanged,
      rewriteUrl,
      source: options.source,
    });
  }

  /**
   * Bind a session's proxy context. Subsequent backend-path requests on this
   * session will be rewritten via `rewriteUrl` and have `Oidc-Auth` injected.
   */
  register(session: Session, context: BackendProxyContext) {
    if (!session) return;
    this.contexts.set(session, context);
  }

  private hasContext(session: Session) {
    return this.contexts.has(session);
  }

  /**
   * Build an `app://` request interceptor that diverts backend-prefixed paths
   * (trpc / webapi / api/auth / market) through `proxy()` against the default
   * session. Plug into `RendererProtocolManager.addRequestInterceptor` so the
   * protocol manager doesn't need to know what "backend" means.
   *
   * Returns `null` for non-backend paths (lets the fallback run). Returns a
   * 502 if the backend context isn't wired up yet, and a 401 when it is but no
   * remote server is configured (not signed in) — for backend prefixes we
   * must never fall through to the SPA HTML / Vite path.
   */
  createAppRequestInterceptor(): RendererRequestInterceptor {
    return async (request) => {
      const url = new URL(request.url);
      if (!isBackendPath(url.pathname)) return null;
      if (!isSandboxedBackendRequestAllowed(request.headers.get('origin')))
        return new Response('Forbidden', { status: 403 });

      const session = electronSession.defaultSession;
      if (!session)
        return new Response('Backend Proxy Unavailable: no default session', { status: 502 });

      try {
        const proxied = await this.proxy(request, session);
        if (proxied) return proxied;

        // Nothing was proxied. With a bound context that means there is no remote server to
        // send this to (not signed in): answer as unauthenticated. Without a context the
        // wiring itself is missing, which is an app problem and stays a 502.
        if (this.hasContext(session)) return notSignedInResponse(url.pathname);
        return new Response('Backend Proxy Unavailable: no proxy context for this session', {
          status: 502,
        });
      } catch (error) {
        const reason = describeError(error);
        this.logger.error(`BackendProxy interceptor failed (${reason}): ${request.url}`, error);
        this.surfaceUncaughtProxyError(error);

        return new Response(proxyNetworkErrorBody(reason), {
          headers: new Headers({
            'Content-Type': 'application/json',
            'X-Proxy-Error': reason,
          }),
          status: 502,
        });
      }
    };
  }

  /**
   * Proxy a renderer-originated request through the remote LobeHub backend.
   * Returns `null` if the session has no proxy context registered yet (caller
   * decides how to fall back). Upstream network failures become a controlled
   * 502 response so they do not escape Electron's `protocol.handle` callback.
   */
  async proxy(request: Request, session: Session): Promise<Response | null> {
    const context = this.contexts.get(session);
    if (!context) return null;

    const logPrefix = context.source ? `[${context.source}] BackendProxy` : '[BackendProxy]';

    const rewrittenUrl = await context.rewriteUrl(request.url);
    if (!rewrittenUrl) return null;

    const headers = new Headers(request.headers);
    const token = await context.getAccessToken();
    if (token) {
      headers.set('Oidc-Auth', token);
    }
    appendVercelCookie(headers);
    setDesktopUserAgentHeader(headers);

    const requestInit: RequestInit & { duplex?: 'half' } = {
      headers,
      method: request.method,
    };

    // Only forward body for non-GET/HEAD requests
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const body = request.body ?? undefined;
      if (body) {
        requestInit.body = body;
        // Node.js (undici) requires `duplex` when sending a streaming body
        requestInit.duplex = 'half';
      }
    }

    let upstreamResponse: Response;
    this.pendingUpstream += 1;
    try {
      upstreamResponse = await netFetch(rewrittenUrl, requestInit);
    } catch (error) {
      // Drop this request from the gauge before snapshotting it: it has already
      // settled (in failure), so counting it would report `pendingUpstream=1` for
      // a lone failure with nothing else in flight — an inflation that reads like
      // the very backlog the gauge exists to detect.
      this.pendingUpstream -= 1;

      // The Chromium error (net::ERR_*) is the whole diagnosis — carry it into
      // the log, the body, and a header so it is readable from DevTools without
      // a debug build.
      const reason = describeError(error);
      const gauges = `pendingUpstream=${this.pendingUpstream}, openUpstreamBodies=${this.openUpstreamBodies}`;
      this.logger.error(
        `${logPrefix} upstream fetch failed (${reason}) [${gauges}]: ${rewrittenUrl}`,
        error,
      );
      this.surfaceUncaughtProxyError(error);

      const responseHeaders = new Headers({
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Expose-Headers': '*',
        'Content-Type': 'application/json',
        'X-Proxy-Error': reason,
        'X-Proxy-Open-Upstream-Bodies': String(this.openUpstreamBodies),
        'X-Proxy-Pending-Upstream': String(this.pendingUpstream),
        'X-Src-Url': rewrittenUrl,
      });
      const allowOrigin = request.headers.get('Origin') || undefined;
      if (allowOrigin) {
        responseHeaders.set('Access-Control-Allow-Origin', allowOrigin);
        responseHeaders.set('Access-Control-Allow-Credentials', 'true');
      }
      return new Response(proxyNetworkErrorBody(reason, rewrittenUrl), {
        headers: responseHeaders,
        status: 502,
        statusText: 'Bad Gateway',
      });
    }
    // Headers are in: this request is no longer *pending*. The failure path above
    // already decremented, so this must not run in a `finally` (that would double
    // count and drive the gauge negative).
    this.pendingUpstream -= 1;

    const responseHeaders = new Headers(upstreamResponse.headers);
    const allowOrigin = request.headers.get('Origin') || undefined;

    if (allowOrigin) {
      responseHeaders.set('Access-Control-Allow-Origin', allowOrigin);
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');
    }

    if (isDev) {
      responseHeaders.set('x-dev-oidc-auth', token);
    }

    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    responseHeaders.set('X-Src-Url', rewrittenUrl);

    // 409 TENANT_ENDPOINT_CHANGED only says the tenant moved. Never follow the address in
    // the body: tell the owner of the session so it can pause and ask for a fresh login.
    if (upstreamResponse.status === 409 && context.onEndpointChanged) {
      try {
        const body = (await upstreamResponse.clone().text()).slice(0, 2048);
        if ((JSON.parse(body) as { code?: unknown })?.code === 'TENANT_ENDPOINT_CHANGED') {
          this.logger.warn(`${logPrefix} tenant endpoint changed`);
          context.onEndpointChanged();
        }
      } catch {
        // Not the endpoint-changed body; leave the response to the renderer as is.
      }
    }

    // Re-auth prompt: rely on X-Auth-Required (set by tRPC responseMeta for UNAUTHORIZED).
    // Batched tRPC responses can use HTTP 207 when calls mix success (200) and UNAUTHORIZED (401);
    // checking only status === 401 misses that case and the login modal never opens.
    // Other failures keep 401 without this header (e.g., invalid API keys) and must not notify here.
    const authRequired = upstreamResponse.headers.get(AUTH_REQUIRED_HEADER) === 'true';
    const isAuthStatus = upstreamResponse.status === 401 || upstreamResponse.status === 403;
    if (authRequired || isAuthStatus) {
      const pathTag = (() => {
        try {
          return new URL(rewrittenUrl).pathname;
        } catch {
          return rewrittenUrl;
        }
      })();
      const sourceTag = context.source ? `${context.source}:` : '';
      const wwwAuth = upstreamResponse.headers.get('www-authenticate') ?? '';
      const authFailure = upstreamResponse.headers.get(AUTH_FAILURE_HEADER) ?? '';
      // Clone before forwarding the body downstream — the original stream stays
      // intact for the renderer. Body snippet is truncated to keep logs small
      // and to avoid leaking large payloads if the server ever returns one.
      let bodySnippet: string;
      try {
        bodySnippet = (await upstreamResponse.clone().text()).slice(0, 300).replaceAll(/\s+/g, ' ');
      } catch (error) {
        bodySnippet = `<body-read-failed:${error instanceof Error ? error.message : 'unknown'}>`;
      }
      const parts = [
        `proxy:${sourceTag}status=${upstreamResponse.status}`,
        `${request.method} ${pathTag}`,
        `hadToken=${Boolean(token)}`,
        `authRequired=${authRequired}`,
        describeJwtClaims(token),
      ];
      if (authFailure) parts.push(`authFailure=${authFailure}`);
      if (wwwAuth) parts.push(`wwwAuth=${wwwAuth}`);
      if (bodySnippet) parts.push(`body=${bodySnippet}`);
      const reason = parts.join(' ');
      // Every auth-status response lands in the production log file, not only
      // the ones that open the re-login modal: a 401 without X-Auth-Required is
      // exactly the case that was previously invisible in user-supplied logs.
      this.logger.info(`${logPrefix} auth response ${reason}`);
      if (authRequired) this.notifyAuthorizationRequired(reason);
    }

    return new Response(
      upstreamResponse.body ? this.trackUpstreamBody(upstreamResponse.body) : null,
      {
        headers: responseHeaders,
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
      },
    );
  }
}

export const backendProxyProtocolManager = new BackendProxyProtocolManager();
