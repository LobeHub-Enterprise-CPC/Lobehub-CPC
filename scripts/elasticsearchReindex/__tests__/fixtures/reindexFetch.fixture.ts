// The sandbox forbids HTTP listeners. Relay fetch over IPC to the parent ES test server.
let requestId = 0;
const pending = new Map<
  number,
  { resolve: (response: Response) => void; reject: (error: Error) => void }
>();
process.on(
  'message',
  (message: { type?: string; id: number; body: string; status: number; error?: string }) => {
    if (message.type !== 'es-response') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else
      request.resolve(
        new Response(message.body, {
          status: message.status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    if (pending.size === 0) process.channel?.unref();
  },
);

globalThis.fetch = async (input, init = {}) =>
  new Promise<Response>((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    process.channel?.ref();
    process.send!(
      { type: 'es-request', id, url: String(input), method: init.method ?? 'GET', body: init.body },
      (error) => {
        if (error) {
          pending.delete(id);
          reject(error);
        }
      },
    );
  });
// An IPC listener must not keep a completed CLI alive.
process.channel?.unref();
