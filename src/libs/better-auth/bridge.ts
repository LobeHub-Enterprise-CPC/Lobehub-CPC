import { z } from 'zod';

const betterAuthBasePath = '/api/auth';

const taskSchema = z.object({
  clientId: z.string().regex(/^[\w-]{1,128}$/),
  csrfToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
  loginUrl: z.string().url(),
  request: z.string().min(1),
  taskId: z.string().min(1),
});
export type BridgeCompletion = {
  callbackURL?: string;
  success: true;
};
export type BridgeLogin = { cancel: () => void; completion: Promise<BridgeCompletion> };

/** Must be called directly from the click handler, before any await. */
export const beginBridgeLogin = (providerId: string, callbackURL = '/'): BridgeLogin => {
  const popup = window.open('about:blank', '_blank', 'popup,width=600,height=760');
  if (!popup) throw new Error('BRIDGE_POPUP_BLOCKED');
  const controller = new AbortController();
  let task: z.infer<typeof taskSchema> | undefined;
  let origin: string | undefined;
  let sent = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let timeout = false;
  const ready = (event: MessageEvent) => {
    if (sent || !task || !origin || event.origin !== origin || event.source !== popup) return;
    const data: unknown = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const message = data as Record<string, unknown>;
    if (
      Object.keys(message).length !== 2 ||
      message.type !== 'identity-bridge-ready' ||
      message.client_id !== task.clientId
    )
      return;
    sent = true;
    popup.postMessage(
      { client_id: task.clientId, request: task.request, type: 'identity-bridge-request' },
      origin,
    );
  };
  window.addEventListener('message', ready);
  const cancel = () => controller.abort();
  window.addEventListener('pagehide', cancel);
  const popupTimer = setInterval(() => {
    if (popup.closed) cancel();
  }, 500);
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${betterAuthBasePath}/bridge/${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
      headers:
        body === undefined
          ? undefined
          : {
              'content-type': 'application/json',
            },
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('BRIDGE_LOGIN_FAILED');
    return response.json();
  };
  const waitForPoll = () =>
    new Promise<void>((resolve, reject) => {
      if (controller.signal.aborted) {
        reject(new Error('BRIDGE_CANCELLED'));
        return;
      }
      const abort = () => {
        clearTimeout(pollTimer);
        reject(new Error('BRIDGE_CANCELLED'));
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      pollTimer = setTimeout(() => {
        controller.signal.removeEventListener('abort', abort);
        resolve();
      }, 2000);
    });
  const expire = () => {
    timeout = true;
    controller.abort();
  };
  timer = setTimeout(expire, 30_000);
  const completion = (async (): Promise<BridgeCompletion> => {
    try {
      task = taskSchema.parse(await request('task', { callbackURL, providerId }));
      const url = new URL(task.loginUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== '/login' ||
        url.searchParams.get('client_id') !== task.clientId ||
        [...url.searchParams.keys()].length !== 1
      )
        throw new Error('BRIDGE_LOGIN_FAILED');
      origin = url.origin;
      const remaining = Math.min(task.expiresAt * 1000 - Date.now(), 10 * 60_000);
      if (remaining <= 0) throw new Error('BRIDGE_EXPIRED');
      clearTimeout(timer);
      timer = setTimeout(expire, remaining);
      if (controller.signal.aborted) throw new Error('BRIDGE_CANCELLED');
      popup.location.replace(url.href);
      while (!controller.signal.aborted) {
        const status = await request(`task/${encodeURIComponent(task.taskId)}`);
        if (controller.signal.aborted || popup.closed) throw new Error('BRIDGE_CANCELLED');
        if (status?.state === 'ready') {
          clearInterval(popupTimer);
          // Exactly one completion attempt; never replay an ambiguous response.
          const result: BridgeCompletion = await request('complete', {
            csrfToken: task.csrfToken,
            taskId: task.taskId,
          });
          if (controller.signal.aborted) throw new Error('BRIDGE_CANCELLED');
          if (result.success !== true) throw new Error('BRIDGE_LOGIN_FAILED');
          return result;
        }
        if (status?.state === 'expired') throw new Error('BRIDGE_EXPIRED');
        if (status?.state !== 'pending') throw new Error('BRIDGE_LOGIN_FAILED');
        await waitForPoll();
      }
      throw new Error('BRIDGE_CANCELLED');
    } catch (error) {
      if (timeout) throw new Error('BRIDGE_EXPIRED', { cause: error });
      if (controller.signal.aborted) throw new Error('BRIDGE_CANCELLED', { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(pollTimer);
      clearInterval(popupTimer);
      window.removeEventListener('message', ready);
      window.removeEventListener('pagehide', cancel);
      controller.abort();
      // Only the window created by this login attempt is owned here.
      try {
        popup.close();
      } catch {
        /* Authing may sever the opener relationship. */
      }
      task = undefined;
    }
  })();
  return { cancel, completion };
};
