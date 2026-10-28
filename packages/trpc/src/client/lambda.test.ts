import { initTRPC } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lambdaClient, withLlmRelay } from './lambda';

vi.mock('@/const/version', () => ({ isDesktop: false }));
vi.mock('@/services/_auth', () => ({ createHeaderWithAuth: async () => ({}) }));
vi.mock('@/business/client/trpc-headers', () => ({ getBusinessTrpcHeaders: async () => ({}) }));
// i18next is never initialised in this suite, so `t` echoes the key — assertions
// below check which copy was selected, not its wording.
vi.mock('i18next', () => ({ t: (key: string) => key }));

const authState = vi.hoisted(() => ({ isSignedIn: true, isSigningOut: false, logout: vi.fn() }));
const redirect = vi.hoisted(() => vi.fn());
vi.mock('@/store/user/store', () => ({ getUserStoreState: () => authState }));
vi.mock('@/components/Error/loginRequiredNotification', () => ({ loginRequired: { redirect } }));

const okTrpcResponse = (data: unknown) =>
  new Response(JSON.stringify({ result: { data: superjson.serialize(data) } }), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });

describe('lambdaClient sign-out boundary', () => {
  afterEach(() => {
    authState.isSigningOut = false;
    authState.logout.mockClear();
    redirect.mockClear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([true, false])('handles a 401 with intentional sign-out=%s', async (isSigningOut) => {
    authState.isSigningOut = isSigningOut;
    vi.spyOn(Date, 'now').mockReturnValue(isSigningOut ? 1_800_000_000_000 : 1_800_000_010_000);
    vi.stubGlobal('location', new URL('http://localhost/t/acme/agent'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: superjson.serialize({
              code: -32_001,
              data: { code: 'UNAUTHORIZED', httpStatus: 401 },
              message: 'UNAUTHORIZED',
            }),
          }),
          { headers: { 'content-type': 'application/json' }, status: 401 },
        ),
      ),
    );

    await expect(
      lambdaClient.agent.getAgentConfigById.query({ agentId: 'agt_test' }),
    ).rejects.toThrow('UNAUTHORIZED');
    expect(authState.logout).toHaveBeenCalledTimes(isSigningOut ? 0 : 1);
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('lambdaClient large-input query transport', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', new URL('http://localhost/chat'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  // Regression: the visible-topic candidate set (up to 1000 ids) blows the
  // httpBatchLink GET URL budget (maxURLLength 2083) and used to be rejected
  // client-side with "Input is too big for a single dispatch" before any
  // request was made. These procedures must go over POST instead.
  it.each([
    [
      'agent.getTransferJobStatus',
      () =>
        lambdaClient.agent.getTransferJobStatus.query({
          agentId: 'agt_test',
          topicIds: Array.from({ length: 1000 }, (_, i) => `tpc_${String(i).padStart(16, '0')}`),
        }),
      'topicIds',
      1000,
    ],
    [
      'group.getTransferJobStatus',
      () =>
        lambdaClient.group.getTransferJobStatus.query({
          groupId: 'grp_test',
          topicIds: Array.from({ length: 1000 }, (_, i) => `tpc_${String(i).padStart(16, '0')}`),
        }),
      'topicIds',
      1000,
    ],
  ] as const)(
    'sends %s with a large path/id array as a POST request',
    async (path, call, arrayField, expectedLength) => {
      fetchMock.mockResolvedValueOnce(okTrpcResponse(null));

      await expect(call()).resolves.toBeNull();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [input, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
      expect(init.method).toBe('POST');
      // The input travels in the body, not the query string.
      expect(String(input)).toContain(`/trpc/lambda/${path}`);
      expect(String(input).length).toBeLessThan(2083);
      const body = JSON.parse(String(init.body)) as { json: Record<string, unknown[]> };
      expect(body.json[arrayField]).toHaveLength(expectedLength);
    },
  );
});

describe('lambdaClient transport lanes', () => {
  const fetchMock = vi.fn();

  // A batched request expects an array body with one entry per operation in it
  // (the procedures are comma-joined in the path); an unbatched one expects the
  // plain result object. Answering both shapes keeps a wrongly-shared batch from
  // failing as a transport error instead of the assertion that describes it.
  const respondByLane = (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes('batch=1')) return Promise.resolve(okTrpcResponse(null));

    const procedures = url.split('/trpc/lambda/')[1]?.split('?')[0]?.split(',') ?? [''];
    return Promise.resolve(
      new Response(
        JSON.stringify(procedures.map(() => ({ result: { data: superjson.serialize(null) } }))),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    );
  };

  const requestedUrls = () =>
    fetchMock.mock.calls.map(([input]) => String(input as RequestInfo | URL));

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', new URL('http://localhost/chat'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('streams a large Canvas snapshot without buffering it with ordinary reads', async () => {
    const t = initTRPC.create({ transformer: superjson });
    const snapshot = { entry: 'index.html', files: [{ content: 'a'.repeat(6 * 1024 * 1024) }] };
    const router = t.router({
      agent: t.router({ getAgentConfigById: t.procedure.query(() => null) }),
      canvas: t.router({ getProject: t.procedure.query(() => snapshot) }),
    });
    const transports: { streaming: boolean; url: string }[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit) => {
      const req = new Request(new URL(String(input), 'http://localhost'), init);
      const streaming = req.headers.get('trpc-accept') === 'application/jsonl';
      transports.push({ streaming, url: req.url });
      const response = await fetchRequestHandler({
        createContext: () => ({}),
        endpoint: '/trpc/lambda',
        req,
        router,
      });
      if (streaming) return response;
      const text = await response.text();
      return text.length > 4_500_000
        ? new Response('Response payload too large', { status: 500 })
        : new Response(text, { headers: response.headers });
    });

    const [result] = await Promise.all([
      lambdaClient.canvas.getProject.query({ canvasId: 'cvs_large', version: 1 }),
      lambdaClient.agent.getAgentConfigById.query({ agentId: 'agt_test' }),
    ]);

    expect(result).toEqual(snapshot);
    expect(transports).toHaveLength(2);
    expect(transports.find((item) => item.streaming)?.url).toContain('/canvas.getProject?');
    expect(transports.find((item) => item.streaming)?.url).not.toContain(
      'agent.getAgentConfigById',
    );
  });

  // Regression: every `device.*` read hops from the server to one of the user's
  // own machines and is capped by a 10-60s RPC timeout. Batched with ordinary
  // lambda reads, one sleeping laptop held the whole batch's response — opening a
  // topic with a working directory fires several such hops at once, which is what
  // made an obviously-live run render as idle after a topic switch.
  it('keeps device.* hops out of the batch carrying ordinary lambda reads', async () => {
    fetchMock.mockImplementation(respondByLane);

    await Promise.all([
      lambdaClient.device.gitBranch.query({ deviceId: 'dev_1', path: '/repo' }),
      lambdaClient.agent.getAgentConfigById.query({ agentId: 'agt_test' }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = requestedUrls();
    expect(
      urls.some(
        (url) => url.includes('device.gitBranch') && !url.includes('agent.getAgentConfigById'),
      ),
    ).toBe(true);
    expect(
      urls.some(
        (url) => url.includes('agent.getAgentConfigById') && !url.includes('device.gitBranch'),
      ),
    ).toBe(true);
  });

  // The gateway reconnect cannot register its local operation — and so cannot
  // show the status tray, the sidebar elapsed time or the stop button — until
  // this token comes back. It is a cheap read; it must never queue behind a
  // slower sibling in the shared batch.
  it('sends the gateway token refresh as its own unbatched request', async () => {
    fetchMock.mockImplementation(respondByLane);

    await Promise.all([
      lambdaClient.aiAgent.refreshGatewayToken.query({ topicId: 'tpc_1' }),
      lambdaClient.agent.getAgentConfigById.query({ agentId: 'agt_test' }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tokenUrl = requestedUrls().find((url) => url.includes('aiAgent.refreshGatewayToken'));
    expect(tokenUrl).toBeDefined();
    expect(tokenUrl).not.toContain('batch=1');
    expect(tokenUrl).not.toContain('agent.getAgentConfigById');
  });

  // One-shot relay: the server reads the channel this tab subscribed from the
  // request headers, so the call carries its own headers and never shares a
  // batch with calls that must not be relayed.
  it('sends a call with one-shot relay headers unbatched, with its headers', async () => {
    fetchMock.mockImplementation(respondByLane);
    const relay = {
      headers: { 'x-lobe-client-id': 'tab-1', 'x-lobe-llm-relay-channel': 'llmcall:u:abcdefgh' },
    };

    await Promise.all([
      lambdaClient.agent.getAgentConfigById.query({ agentId: 'agt_test' }, withLlmRelay(relay)),
      lambdaClient.agent.getAgentConfigById.query({ agentId: 'agt_other' }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const relayed = fetchMock.mock.calls.find(([, init]) =>
      new Headers((init as RequestInit).headers).has('x-lobe-llm-relay-channel'),
    );
    expect(relayed).toBeDefined();
    expect(String(relayed![0])).not.toContain('batch=1');
    const headers = new Headers((relayed![1] as RequestInit).headers);
    expect(headers.get('x-lobe-llm-relay-channel')).toBe('llmcall:u:abcdefgh');
    expect(headers.get('x-lobe-client-id')).toBe('tab-1');
  });
});

describe('lambdaClient unreadable response handling', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', new URL('http://localhost/chat'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  // Regression: a JSON body that is not a `TRPCResponse` makes @trpc/client
  // throw `TransformResultError`, and its internal message used to reach the
  // UI — the agent-config alert above the chat input rendered "Unable to
  // transform response from server" while the desktop app was simply offline.
  it('replaces the transform error with the diagnosed network copy', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          body: { detail: 'net::ERR_CONNECTION_REFUSED' },
          errorType: 'RemoteServerConnectionRefused',
        }),
        { headers: { 'content-type': 'application/json' }, status: 502 },
      ),
    );

    await expect(
      lambdaClient.agent.getAgentConfigById.query({ agentId: 'agt_test' }),
    ).rejects.toThrow('response.RemoteServerConnectionRefused');
  });

  it('falls back to generic copy for foreign JSON without a known error type', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Forbidden' }), {
        headers: { 'content-type': 'application/json' },
        status: 403,
      }),
    );

    await expect(
      lambdaClient.agent.getAgentConfigById.query({ agentId: 'agt_test' }),
    ).rejects.toThrow('response.UnreadableServerResponse');
  });

  // The workspace-unavailable screen explains a closed tenant; every request it
  // refuses must neither log an error nor make SWR retry against a closed gate.
  it('stops retrying a request refused because the workspace is closed', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: superjson.serialize({
            code: -32_003,
            data: { code: 'FORBIDDEN', httpStatus: 403 },
            message: 'TENANT_FROZEN',
          }),
        }),
        { headers: { 'content-type': 'application/json' }, status: 403 },
      ),
    );

    const error = await lambdaClient.agent.getAgentConfigById
      .query({ agentId: 'agt_test' })
      .catch((error_: any) => error_);
    expect(error.message).toBe('TENANT_FROZEN');
    expect(error.meta?.shouldRetry).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('keeps a well-formed tRPC error message untouched', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: superjson.serialize({
            code: -32_600,
            data: { code: 'BAD_REQUEST', httpStatus: 400 },
            message: 'agentId is required',
          }),
        }),
        { headers: { 'content-type': 'application/json' }, status: 400 },
      ),
    );

    await expect(
      lambdaClient.agent.getAgentConfigById.query({ agentId: 'agt_test' }),
    ).rejects.toThrow('agentId is required');
  });
});
