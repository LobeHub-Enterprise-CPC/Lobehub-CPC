import { currentTenantScope, trackTenantWork } from '@lobechat/database/tenant';
import debug from 'debug';

const log = debug('bot-platform:feishu:gateway');

export interface FeishuWSOptions {
  appId: string;
  appSecret: string;
  /** 'feishu' or 'lark' — determines the API domain */
  domain: 'feishu' | 'lark';
  /**
   * Verification token configured by the user. When provided, it is injected
   * into the forwarded webhook payload's `header.token` so the downstream
   * webhook handler's token check passes.
   */
  verificationToken?: string;
  /** URL to forward events to (POST) */
  webhookUrl: string;
}

/**
 * Wraps the official Lark SDK's WSClient to manage a persistent WebSocket
 * connection for Feishu/Lark bots.
 *
 * Events received via WebSocket are forwarded to the webhook URL as HTTP POSTs,
 * preserving compatibility with the existing handleWebhook() pipeline.
 */
export class FeishuWSConnection {
  private readonly options: FeishuWSOptions;
  private wsClient: any = null;
  private closing?: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly socketReceipts = new WeakMap<
    object,
    { done: () => void; work: Promise<void> }
  >();

  private remember<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    return work;
  }

  private waitForSocket(socket: any): Promise<void> {
    const existing = this.socketReceipts.get(socket);
    if (socket.readyState === 3) {
      existing?.done();
      return existing?.work ?? Promise.resolve();
    }
    if (existing) {
      socket.once('close', existing.done);
      return existing.work;
    }
    let done!: () => void;
    const settled = new Promise<void>((resolve) => {
      done = resolve;
    });
    // This runs inside SDK teardown, sometimes after admission is revoked.
    // Register only with this connection's local close barrier: throwing here
    // would prevent the SDK from reaching socket.terminate().
    const work = this.remember(settled);
    this.socketReceipts.set(socket, { done, work });
    socket.once('close', done);
    return work;
  }

  constructor(options: FeishuWSOptions) {
    this.options = options;
  }

  /**
   * Start the WebSocket connection using the Lark SDK's WSClient.
   * The SDK handles connect, ping, and reconnect internally.
   */
  async start(): Promise<void> {
    const lark = await import('@larksuiteoapi/node-sdk');

    const eventDispatcher = new lark.EventDispatcher({});

    // Register handler for incoming messages
    eventDispatcher.register({
      'im.message.receive_v1': async (data: any) => {
        log('Received im.message.receive_v1 event');
        await trackTenantWork(() => this.forwardEvent('im.message.receive_v1', data));
      },
    });

    const domain = this.options.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

    this.wsClient = new lark.WSClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.info,
    });

    // The SDK has no asynchronous close API. Track its reconnect operation and
    // discarded sockets explicitly. Refuse an incompatible SDK before startup;
    // silently dropping these hooks would make strict-stop acknowledgement false.
    const client = this.wsClient;
    if (currentTenantScope()) {
      if (
        ['reConnect', 'detachSocket', 'pullConnectConfig', 'connect'].some(
          (method) => typeof client[method] !== 'function',
        )
      )
        throw new Error('FEISHU_SDK_STOP_RECEIPT_UNSUPPORTED');
      const reconnect = client.reConnect.bind(client);
      client.reConnect = (...args: unknown[]) =>
        this.remember(trackTenantWork(() => reconnect(...args)));
      // Non-initial SDK reConnect() resolves after scheduling a timer. Track
      // the actual HTTP config request and handshake that the timer starts.
      const pullConfig = client.pullConnectConfig.bind(client);
      client.pullConnectConfig = (...args: unknown[]) => {
        if (client.closed) return Promise.resolve({ ok: false, retryable: false });
        return this.remember(Promise.resolve(pullConfig(...args)));
      };
      const connect = client.connect.bind(client);
      client.connect = (...args: unknown[]) => {
        if (client.closed) return Promise.resolve(false);
        return this.remember(
          Promise.resolve(connect(...args)).then(async (connected) => {
            if (!client.closed) return connected;
            const socket = client.wsConfig.getWSInstance();
            // Do not await close before terminating: the SDK cannot discard the
            // late handshake until this promise returns.
            client.close({ force: true });
            if (socket) await this.waitForSocket(socket);
            return false;
          }),
        );
      };
      const detach = client.detachSocket.bind(client);
      client.detachSocket = (socket: any) => {
        detach(socket); // SDK removes all old event listeners.
        this.waitForSocket(socket);
      };
    }
    await client.start({ eventDispatcher });
    log('WSClient started (domain=%s, appId=%s)', this.options.domain, this.options.appId);
  }

  /**
   * Close the WebSocket connection.
   */
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const client = this.wsClient;
    if (!client) return;
    const work = (async () => {
      const socket = client.wsConfig?.getWSInstance?.();
      client.close({ force: true });
      // Attach after close(): SDK detachSocket removes all listeners. A force
      // close request still needs the real socket close event.
      if (socket) this.waitForSocket(socket);
      while (this.pending.size) await Promise.all(this.pending);
      this.wsClient = null;
      log('WSClient closed');
    })();
    this.closing = work;
    try {
      await work;
    } finally {
      if (this.closing === work) this.closing = undefined;
    }
  }

  /**
   * Forward an event to the webhook URL.
   * The webhook handler expects the Lark event payload wrapped in the standard format.
   *
   * Note: events received via WebSocket are pre-authenticated by the SDK, but the
   * downstream webhook handler still validates `header.token` against the user's
   * configured `verificationToken`. We inject the configured token into the payload
   * so the check passes.
   */
  private async forwardEvent(eventType: string, data: any): Promise<void> {
    // Construct a webhook-compatible payload matching what handleWebhook() expects
    const header: Record<string, string> = {
      event_type: eventType,
    };
    if (this.options.verificationToken) {
      header.token = this.options.verificationToken;
    }

    const webhookPayload = {
      event: data,
      header,
      schema: '2.0',
    };

    try {
      await fetch(this.options.webhookUrl, {
        body: JSON.stringify(webhookPayload),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      log('Failed to forward event %s to webhook: %O', eventType, err);
    }
  }
}
