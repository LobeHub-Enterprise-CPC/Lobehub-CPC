// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { beginBridgeLogin } from './bridge';

const task = {
  clientId: 'admin',
  csrfToken: 'csrf',
  expiresAt: 0,
  loginUrl: 'https://bridge.internal/login?client_id=admin',
  request: 'secret.signed.request',
  taskId: 'task1',
};
let handler: (event: MessageEvent) => void;
let pagehide: () => void;
let popup: {
  close: ReturnType<typeof vi.fn>;
  closed: boolean;
  location: { replace: ReturnType<typeof vi.fn> };
  postMessage: ReturnType<typeof vi.fn>;
};
let fetcher: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
const response = (data: unknown) => ({ json: async () => data, ok: true });
const send = (overrides: Record<string, unknown> = {}) =>
  handler({
    data: { client_id: 'admin', type: 'identity-bridge-ready' },
    origin: 'https://bridge.internal',
    source: popup,
    ...overrides,
  } as unknown as MessageEvent);
beforeEach(() => {
  vi.useFakeTimers();
  task.loginUrl = 'https://bridge.internal/login?client_id=admin';
  task.expiresAt = Math.floor(Date.now() / 1000) + 60;
  popup = { close: vi.fn(), closed: false, location: { replace: vi.fn() }, postMessage: vi.fn() };
  remove = vi.fn();
  vi.stubGlobal('window', {
    addEventListener: vi.fn((event, listener) => {
      if (event === 'message') handler = listener;
      if (event === 'pagehide') pagehide = listener;
    }),
    open: vi.fn(() => popup),
    removeEventListener: remove,
  });
  fetcher = vi
    .fn()
    .mockResolvedValueOnce(response(task))
    .mockResolvedValue(response({ state: 'pending' }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('bridge browser handoff', () => {
  it('does not complete when the popup closes just before ready arrives', async () => {
    fetcher
      .mockReset()
      .mockResolvedValueOnce(response(task))
      .mockImplementationOnce(async () => {
        popup.closed = true;
        return response({ state: 'ready' });
      });
    await expect(beginBridgeLogin('company').completion).rejects.toThrow('BRIDGE_CANCELLED');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('ignores a completion response arriving after the parent page closes', async () => {
    fetcher
      .mockReset()
      .mockResolvedValueOnce(response(task))
      .mockResolvedValueOnce(response({ state: 'ready' }))
      .mockImplementationOnce(async () => {
        pagehide();
        return response({ success: true });
      });
    await expect(beginBridgeLogin('company').completion).rejects.toThrow('BRIDGE_CANCELLED');
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    ['http://admin.test', 'http://bridge.internal'],
    ['http://admin.test', 'https://bridge.internal'],
    ['https://admin.test', 'http://bridge.internal'],
    ['https://admin.test', 'https://bridge.internal'],
  ])('hands off from %s to %s with an exact message origin', async (adminOrigin, bridgeOrigin) => {
    Object.assign(window, { location: { origin: adminOrigin } });
    task.loginUrl = `${bridgeOrigin}/login?client_id=admin`;
    const attempt = beginBridgeLogin('company');
    const finished = attempt.completion.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.location.replace).toHaveBeenCalledWith(task.loginUrl);
    send({
      origin: bridgeOrigin.replace(/^https?/, bridgeOrigin.startsWith('https:') ? 'http' : 'https'),
    });
    expect(popup.postMessage).not.toHaveBeenCalled();
    send({ origin: bridgeOrigin });
    expect(popup.postMessage).toHaveBeenCalledExactlyOnceWith(
      { client_id: task.clientId, request: task.request, type: 'identity-bridge-request' },
      bridgeOrigin,
    );
    attempt.cancel();
    expect(await finished).toBe('BRIDGE_CANCELLED');
  });

  it('opens synchronously, validates origin/source/client/schema and sends the request only once', async () => {
    const attempt = beginBridgeLogin('company');
    const finished = attempt.completion.catch((error: Error) => error.message);
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank', expect.any(String));
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.location.replace).toHaveBeenCalledWith(task.loginUrl);
    expect(window.addEventListener).toHaveBeenCalledBefore(popup.location.replace);
    send({ origin: 'https://evil.example' });
    send({ source: {} });
    send({ data: { client_id: 'other', type: 'identity-bridge-ready' } });
    send({ data: { client_id: 'admin', request: 'injected', type: 'identity-bridge-ready' } });
    expect(popup.postMessage).not.toHaveBeenCalled();
    send();
    send();
    expect(popup.postMessage).toHaveBeenCalledExactlyOnceWith(
      { client_id: 'admin', request: task.request, type: 'identity-bridge-request' },
      'https://bridge.internal',
    );
    attempt.cancel();
    expect(await finished).toBe('BRIDGE_CANCELLED');
    expect(remove).toHaveBeenCalledWith('message', handler);
    expect(popup.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('completes exactly once with browser CSRF', async () => {
    fetcher
      .mockReset()
      .mockResolvedValueOnce(response(task))
      .mockResolvedValueOnce(response({ state: 'pending' }))
      .mockResolvedValueOnce(response({ state: 'ready' }))
      .mockResolvedValueOnce(response({ success: true }));
    const attempt = beginBridgeLogin('company');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await attempt.completion).toEqual({ success: true });
    const completeCalls = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/complete'));
    expect(completeCalls).toHaveLength(1);
    expect(JSON.parse(completeCalls[0][1].body)).toEqual({
      csrfToken: task.csrfToken,
      taskId: task.taskId,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels when the popup closes while waiting and releases all resources', async () => {
    const attempt = beginBridgeLogin('company');
    const finished = attempt.completion.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeClose = fetcher.mock.calls.length;
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(await finished).toBe('BRIDGE_CANCELLED');
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(callsBeforeClose);
    expect(remove).toHaveBeenCalledWith('message', handler);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts task creation when the popup closes before the server responds', async () => {
    fetcher.mockReset().mockImplementation(
      (_, options) =>
        new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const attempt = beginBridgeLogin('company');
    const finished = attempt.completion.catch((error: Error) => error.message);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(await finished).toBe('BRIDGE_CANCELLED');
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops polling and closes its popup when the parent page is hidden for navigation', async () => {
    const attempt = beginBridgeLogin('company');
    const finished = attempt.completion.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    const calls = fetcher.mock.calls.length;
    pagehide();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await finished).toBe('BRIDGE_CANCELLED');
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(popup.close).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('pagehide', pagehide);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('finishes an in-flight completion even if the popup closes', async () => {
    let finish!: (value: unknown) => void;
    fetcher
      .mockReset()
      .mockResolvedValueOnce(response(task))
      .mockResolvedValueOnce(response({ state: 'ready' }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const attempt = beginBridgeLogin('company');
    await vi.advanceTimersByTimeAsync(0);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher.mock.calls[2][1].signal.aborted).toBe(false);
    finish(response({ success: true }));
    expect(await attempt.completion).toEqual({ success: true });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('times out and releases the listener and polling timers', async () => {
    task.expiresAt = Math.floor(Date.now() / 1000) + 3;
    const attempt = beginBridgeLogin('company');
    const finished = attempt.completion.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await finished).toBe('BRIDGE_EXPIRED');
    expect(remove).toHaveBeenCalledWith('message', handler);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects blocked popups before creating a server task', () => {
    vi.mocked(window.open).mockReturnValue(null);
    expect(() => beginBridgeLogin('company')).toThrow('BRIDGE_POPUP_BLOCKED');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects URL-carried requests before navigating and does not retry failed completion', async () => {
    fetcher
      .mockReset()
      .mockResolvedValueOnce(response({ ...task, loginUrl: task.loginUrl + '&request=secret' }));
    await expect(beginBridgeLogin('company').completion).rejects.toThrow('BRIDGE_LOGIN_FAILED');
    expect(popup.location.replace).not.toHaveBeenCalled();
    fetcher
      .mockReset()
      .mockResolvedValueOnce(response(task))
      .mockResolvedValueOnce(response({ state: 'ready' }))
      .mockRejectedValueOnce(new Error('lost response'));
    await expect(beginBridgeLogin('company').completion).rejects.toThrow('lost response');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
