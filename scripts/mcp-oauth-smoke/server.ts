/** Local protocol harness: imports production OAuth helpers; does not boot LobeHub or access its DB. */
import { randomBytes } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import {
  buildAuthorizationUrl,
  discoverConnectorOAuth,
  exchangeConnectorCode,
  getConnectorRedirectUri,
  refreshConnectorToken,
  registerDynamicClient,
  registeredAuthMethod,
  toClientInformation,
} from '../../apps/server/src/services/connector/oauth';
import { readMarketplaceOAuth } from '../../src/utils/marketplaceOAuth';

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Pass the real Market Manifest JSON file as the first argument');
const manifest = await Bun.file(manifestPath).json();
const option = manifest.deploymentOptions?.find((o: any) => o.connection?.type === 'http');
const auth = readMarketplaceOAuth(option?.installationDetails);
if (!auth || option.connection.url !== 'https://docs.qq.com/openapi/mcp') {
  throw new Error('This local smoke page requires the Tencent Docs HTTP OAuth Market entry');
}
const resource = option.connection.url as string;
const callback = getConnectorRedirectUri();
const base = new URL(callback).origin;
const origin = new URL(base);
if (origin.hostname !== 'localhost' || origin.protocol !== 'http:') {
  throw new Error('APP_URL must be an http://localhost:<port> local test origin');
}
const ttl = 2 * 60 * 60_000;
type Discovery = Awaited<ReturnType<typeof discoverConnectorOAuth>>;
type Session = {
  createdAt: number;
  events: { step: string; ok: boolean; time: string }[];
  phase: string;
  discovery?: Discovery;
  client?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  tools?: { name: string; inputSchema: unknown }[];
  error?: string;
  busy?: boolean;
};
const sessions = new Map<string, Session>();
const states = new Map<string, { sessionId: string; verifier: string; createdAt: number }>();
const record = (session: Session, step: string, ok = true) => {
  session.events.push({ step, ok, time: new Date().toISOString() });
  session.events = session.events.slice(-30);
  console.log(`[mcp-smoke] ${ok ? 'ok' : 'failed'}: ${step}`);
};
const cleanError = (error: unknown, session: Session) => {
  let message = error instanceof Error ? error.message : 'Request failed';
  for (const secret of [
    session.tokens?.access_token,
    session.tokens?.refresh_token,
    session.client?.client_secret,
  ]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message
    .replaceAll(/([?&](?:code|state|token|client_secret)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 700);
};
const purge = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.createdAt > ttl) sessions.delete(id);
  for (const [id, s] of states) if (now - s.createdAt > 600_000) states.delete(id);
}, 30_000);
purge.unref();
const page = await Bun.file(new URL('index.html', import.meta.url)).text();

async function withMcp<T>(session: Session, operation: (client: Client) => Promise<T>) {
  if (!session.tokens) throw new Error('Authorize first');
  const client = new Client({ name: 'mcp-oauth-local-verification', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { Authorization: `Bearer ${session.tokens.access_token}` } },
  });
  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await client.close().catch(() => {});
  }
}
async function listTools(session: Session) {
  session.tools = await withMcp(session, async (client) => {
    const tools: NonNullable<Session['tools']> = [];
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...result.tools.map(({ name, inputSchema }) => ({ name, inputSchema })));
      cursor = result.nextCursor;
      if (tools.length > 1500) throw new Error('Unexpected tool list size');
    } while (cursor);
    return tools;
  });
  record(session, '工具发现完成');
  session.phase = 'connected';
  console.log(`[mcp-smoke] authenticated tools/list returned ${session.tools.length} tools`);
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(origin.port),
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.headers.get('host') !== origin.host)
      return new Response('Invalid host', { status: 403 });
    let id = req.headers.get('cookie')?.match(/(?:^|;\s*)mcp-smoke=([a-f0-9]{48})(?:;|$)/)?.[1];
    if (!id || !sessions.has(id)) {
      id = randomBytes(24).toString('hex');
      sessions.set(id, { createdAt: Date.now(), events: [], phase: 'ready' });
      headers.set('Set-Cookie', `mcp-smoke=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=7200`);
    }
    const session = sessions.get(id)!;
    const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
    if (req.method === 'POST' && req.headers.get('origin') !== base)
      return json({ error: 'Invalid origin' }, 403);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        headers.set('Content-Type', 'text/html; charset=utf-8');
        headers.set(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
        return new Response(page, { headers });
      }
      if (req.method === 'GET' && url.pathname === '/api/status')
        return json({
          identifier: manifest.identifier,
          name: manifest.name,
          resource,
          auth,
          callback,
          phase: session.phase,
          error: session.error,
          toolCount: session.tools?.length ?? 0,
          tools: session.tools?.map((t) => t.name) ?? [],
          hasRefreshToken: !!session.tokens?.refresh_token,
          expiresIn: session.tokens?.expires_in,
          events: session.events,
          registrationComplete: !!session.client,
          tokenExchangeComplete: !!session.tokens,
        });
      if (req.method === 'GET' && url.pathname === '/oauth/connector/callback') {
        const state = url.searchParams.get('state');
        const pending = state ? states.get(state) : undefined;
        if (!pending || pending.sessionId !== id || Date.now() - pending.createdAt > 600_000) {
          return json({ error: 'Invalid, expired or already consumed OAuth state' }, 400);
        }
        states.delete(state!); // Atomic consume before network IO.
        session.busy = true;
        try {
          if (url.searchParams.has('error'))
            throw new Error(`Provider denied authorization: ${url.searchParams.get('error')}`);
          const code = url.searchParams.get('code');
          if (!code || !session.discovery || !session.client)
            throw new Error('Incomplete callback');
          const { tokens } = await exchangeConnectorCode({
            authorizationCode: code,
            ...session.discovery,
            clientInformation: session.client,
            codeVerifier: pending.verifier,
            redirectUri: callback,
            resource,
          });
          session.tokens = tokens;
          record(session, '授权码换取 Token 完成（值仅保存在本进程内存）');
          await listTools(session);
        } catch (error) {
          session.error = cleanError(error, session);
          session.phase = 'error';
          record(session, '授权或工具发现失败', false);
        } finally {
          session.busy = false;
        }
        headers.set('Location', '/');
        return new Response(null, { status: 303, headers });
      }
      if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
      if (session.busy) return json({ error: 'A request is already in progress' }, 409);
      session.busy = true;
      session.error = undefined;
      try {
        if (url.pathname === '/api/start') {
          session.discovery = await discoverConnectorOAuth(resource);
          record(session, 'OAuth 元数据发现完成');
          session.client ??= await registerDynamicClient({
            ...session.discovery,
            clientName: 'LobeHub MCP local verification',
            redirectUri: callback,
            scopes: auth.scopes,
          });
          record(session, 'DCR 注册完成 / 已复用注册结果');
          const state = randomBytes(32).toString('hex');
          const result = await buildAuthorizationUrl({
            ...session.discovery,
            clientInformation: session.client,
            redirectUri: callback,
            resource,
            scopes: auth.scopes,
            state,
          });
          for (const [key, value] of states) if (value.sessionId === id) states.delete(key);
          states.set(state, {
            sessionId: id,
            verifier: result.codeVerifier,
            createdAt: Date.now(),
          });
          session.phase = 'authorizing';
          return json({ authorizationUrl: result.authorizationUrl });
        }
        if (url.pathname === '/api/sync') {
          await listTools(session);
          return json({ ok: true, toolCount: session.tools?.length });
        }
        if (url.pathname === '/api/refresh') {
          if (!session.tokens?.refresh_token || !session.discovery || !session.client)
            throw new Error('No refresh token');
          const method = registeredAuthMethod(session.client, session.discovery.metadata);
          const { tokens } = await refreshConnectorToken({
            ...session.discovery,
            clientInformation: toClientInformation({
              clientId: session.client.client_id,
              clientSecret: session.client.client_secret,
              tokenEndpointAuthMethod: method,
            }),
            refreshToken: session.tokens.refresh_token,
            resource,
          });
          session.tokens = {
            ...tokens,
            refresh_token: tokens.refresh_token ?? session.tokens.refresh_token,
          };
          record(session, '刷新 Token 完成（未打印凭据）');
          await listTools(session);
          return json({ ok: true });
        }
        if (url.pathname === '/api/check') {
          const tool = session.tools?.find((t) => t.name === 'check_skill_update');
          if (!tool) throw new Error('Provider did not expose check_skill_update');
          const schema = tool.inputSchema as { required?: string[] };
          if (schema.required?.length)
            throw new Error('This tool needs parameters; automatic invocation skipped');
          const result = await withMcp(session, (client) =>
            client.callTool({ name: tool.name, arguments: {} }),
          );
          if (result.isError) throw new Error('Provider returned a tool execution error');
          record(session, 'check_skill_update 实际只读调用成功');
          return json({
            ok: true,
            contentBlocks: Array.isArray(result.content) ? result.content.length : 0,
          });
        }
        if (url.pathname === '/api/clear') {
          sessions.delete(id);
          for (const [key, value] of states) if (value.sessionId === id) states.delete(key);
          headers.set('Set-Cookie', 'mcp-smoke=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
          return json({ ok: true });
        }
        return json({ error: 'Not found' }, 404);
      } catch (error) {
        session.error = cleanError(error, session);
        session.phase = 'error';
        record(session, '请求失败', false);
        return json({ error: session.error }, 400);
      } finally {
        session.busy = false;
      }
    } catch {
      return json({ error: 'Local verification request failed' }, 500);
    }
  },
});
console.log(`Local MCP OAuth smoke page: ${base}`);
console.log(
  `Manifest: ${manifest.identifier}; callback: ${callback}; no DB/Redis; tokens kept in memory only.`,
);
process.on('SIGTERM', () => {
  clearInterval(purge);
  sessions.clear();
  states.clear();
  server.stop(true);
  process.exit(0);
});
