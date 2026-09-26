import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

/** Per-Run loopback transport. Counts attempts before forwarding; never records credentials/body. */
export async function createChannelModelBudget(input: {
  limit: number;
  onCall: (count: number) => Promise<void>;
  onLimit: (error: Error) => void;
  toolLimit?: number;
  onTool?: (count: number) => Promise<void>;
  upstream: string;
}) {
  const upstream = new URL(input.upstream);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password)
    throw new Error('Unsupported Codex provider endpoint');
  const prefix = `/${randomUUID()}/`;
  const sockets = new Set<Socket>();
  let count = 0;
  let tools = 0;
  const toolIds = new Set<string>();
  const server = createServer(async (req, res) => {
    const route = req.url || '';
    if (!route.startsWith(prefix) || req.headers.upgrade) {
      res.writeHead(404).end();
      return;
    }
    const target = new URL(upstream);
    const suffix = new URL(route, 'http://localhost');
    target.pathname = `${upstream.pathname.replace(/\/$/, '')}/${suffix.pathname.slice(prefix.length)}`;
    target.search = suffix.search || upstream.search;
    try {
      if (req.method !== 'GET') {
        if (req.method !== 'POST') throw new Error('Unsupported Codex model transport');
        if (count >= input.limit) {
          const error = new Error('Channel model call limit reached');
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, type: 'channel_budget' } }));
          input.onLimit(error);
          return;
        }
        // No await between the limit check and increment, including concurrent requests.
        const attempt = ++count;
        await input.onCall(attempt);
      }
      const headers = { ...req.headers, 'host': target.host, 'accept-encoding': 'identity' };
      delete headers.connection;
      let clientDisconnected = false;
      const outgoing = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
        target,
        {
          method: req.method,
          headers,
        },
        (incoming) => {
          res.writeHead(incoming.statusCode || 502, incoming.headers);
          if (
            !input.onTool ||
            !(
              req.method === 'POST' &&
              target.pathname.endsWith('/responses') &&
              incoming.statusCode === 200
            )
          ) {
            incoming.pipe(res);
            incoming.on('error', () => res.destroy());
            return;
          }
          // Deliver a function-call event only after its budget is durably reserved.
          // The CLI cannot start an over-budget command it has not received.
          void (async () => {
            const decoder = new StringDecoder('utf8');
            let buffer = '';
            const forward = async (frame: string) => {
              const data = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (data && data !== '[DONE]') {
                const event = JSON.parse(data);
                const item = event.item;
                if (
                  event.type === 'response.output_item.added' &&
                  item?.id &&
                  [
                    'function_call',
                    'custom_tool_call',
                    'web_search_call',
                    'computer_call',
                    'file_search_call',
                    'code_interpreter_call',
                    'mcp_call',
                  ].includes(item.type) &&
                  !toolIds.has(item.id)
                ) {
                  if (tools >= (input.toolLimit ?? 64))
                    throw new Error('Channel tool call limit reached');
                  toolIds.add(item.id);
                  await input.onTool!(++tools);
                }
              }
              res.write(frame);
            };
            for await (const chunk of incoming) {
              buffer += decoder.write(Buffer.from(chunk));
              if (buffer.length > 8 * 1024 * 1024)
                throw new Error('Codex model event exceeds the Channel transport limit');
              let separator: RegExpExecArray | null;
              while ((separator = /\r?\n\r?\n/.exec(buffer))) {
                const end = separator.index + separator[0].length;
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end);
                await forward(frame);
              }
            }
            buffer += decoder.end();
            if (buffer) await forward(buffer);
            res.end();
          })().catch((error) => {
            // Codex may stop consuming a response once it has its tool calls.
            // Cancellation by that client is not a budget violation.
            if (clientDisconnected || res.destroyed) return;
            input.onLimit(error instanceof Error ? error : new Error(String(error)));
            incoming.destroy();
            res.destroy();
          });
        },
      );
      outgoing.on('socket', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      outgoing.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on('aborted', () => outgoing.destroy());
      res.on('close', () => {
        clientDisconnected = !res.writableEnded;
        outgoing.destroy();
      });
      req.pipe(outgoing);
    } catch (error) {
      if (!res.headersSent) res.writeHead(503);
      res.end();
      input.onLimit(error instanceof Error ? error : new Error(String(error)));
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Model budget listener unavailable');
  return {
    url: `http://127.0.0.1:${address.port}${prefix.slice(0, -1)}`,
    close: () =>
      new Promise<void>((resolve) => {
        sockets.forEach((socket) => socket.destroy());
        server.close(() => resolve());
      }),
  };
}
