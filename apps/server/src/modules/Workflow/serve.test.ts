// @vitest-environment node
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signUpstashRequest } from '@/server/modules/Hatchet/signature';

const published = vi.hoisted(
  () =>
    [] as {
      body: any;
      delay?: number;
      deduplicationId?: string;
      headers?: Record<string, string>;
      retries?: number;
      timeout?: number;
      url: string;
    }[],
);

vi.mock('@/server/modules/Hatchet/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isHatchetDeliveryEnabled: () => false,
}));
vi.mock('@/server/modules/Hatchet/directDelivery', () => ({
  getDirectDeliveryClient: () => ({
    messages: { delete: vi.fn() },
    publishJSON: async (request: (typeof published)[number]) => {
      published.push(request);
      return { messageId: `m${published.length}` };
    },
  }),
}));

const { createWorkflow, serve, serveMany, workflowClient, WorkflowNonRetryableError } =
  await import('./index');

const BASE = 'http://app.test';
let seq = 0;
const unique = (name: string) => `${name}-${++seq}`;

/** Delivers a published message to `app` as the delivery worker would. */
const deliver = (app: Hono, message: (typeof published)[number], attempt = 0, headers = {}) =>
  app.request(message.url, {
    body: JSON.stringify(message.body),
    headers: {
      ...message.headers,
      'Content-Type': 'application/json',
      'Upstash-Retried': String(attempt),
      ...headers,
    },
    method: 'POST',
  });

const lastPublished = () => published.at(-1)!;

beforeEach(() => {
  published.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('workflow runtime', () => {
  it('runs a triggered workflow to completion and ignores a repeated delivery', async () => {
    const step = vi.fn(async () => 'one');
    const app = new Hono().post(
      '/api/wf/simple',
      serve(async (context) => {
        const first = await context.run('first', step);
        return { first, payload: context.requestPayload };
      }),
    );

    const { workflowRunId } = await workflowClient.trigger({
      body: { hello: 'world' },
      headers: { traceparent: 't-1' },
      url: `${BASE}/api/wf/simple`,
    });
    expect(workflowRunId).toMatch(/^wfr_/);
    const trigger = lastPublished();
    expect(trigger).toMatchObject({
      deduplicationId: `${workflowRunId}:0`,
      headers: { traceparent: 't-1' },
      retries: 3,
      // Long enough for a slow model call inside a step, so it is not redelivered mid-call.
      timeout: 3600,
    });

    const response = await deliver(app, trigger);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'done' });

    expect((await deliver(app, trigger, 1)).status).toBe(200);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('replays completed steps on a retry instead of running them again', async () => {
    const paid = vi.fn(async () => 'llm-answer');
    let failOnce = true;
    const app = new Hono().post(
      '/api/wf/retry',
      serve(async (context) => {
        const answer = await context.run('call-model', paid);
        return context.run('write', () => {
          if (failOnce) {
            failOnce = false;
            throw new Error('database blip');
          }
          return answer;
        });
      }),
    );
    await workflowClient.trigger({ url: `${BASE}/api/wf/retry` });
    const trigger = lastPublished();

    expect((await deliver(app, trigger, 0)).status).toBe(500);
    const retried = await deliver(app, trigger, 1);
    expect(await retried.json()).toMatchObject({ status: 'done' });
    expect(paid).toHaveBeenCalledTimes(1);
  });

  it('calls the failure function once when the retries are spent', async () => {
    const failureFunction = vi.fn();
    const app = new Hono().post(
      '/api/wf/fail',
      serve(
        async (context) => {
          await context.run('boom', () => {
            throw new Error('always');
          });
        },
        { failureFunction },
      ),
    );
    await workflowClient.trigger({ body: { id: 'x' }, retries: 1, url: `${BASE}/api/wf/fail` });
    const trigger = lastPublished();

    expect((await deliver(app, trigger, 0)).status).toBe(500);
    expect(failureFunction).not.toHaveBeenCalled();

    const final = await deliver(app, trigger, 1);
    expect(final.status).toBe(200);
    expect(await final.json()).toMatchObject({ status: 'failed' });
    expect(failureFunction).toHaveBeenCalledTimes(1);
    expect(failureFunction.mock.calls[0][0]).toMatchObject({
      context: { requestPayload: { id: 'x' } },
      failResponse: 'always',
      failStatus: 500,
    });

    expect(await (await deliver(app, trigger, 2)).json()).toMatchObject({ status: 'failed' });
    expect(failureFunction).toHaveBeenCalledTimes(1);
  });

  it('fails at once on a non-retryable error, and on a payload the parser rejects', async () => {
    const failureFunction = vi.fn();
    const app = new Hono()
      .post(
        '/api/wf/non-retryable',
        serve(
          async () => {
            throw new WorkflowNonRetryableError('bad input');
          },
          { failureFunction },
        ),
      )
      .post(
        '/api/wf/parsed',
        serve(async () => 'unreachable', {
          failureFunction,
          initialPayloadParser: (raw) => {
            const value = JSON.parse(raw);
            if (!value.ok) throw new Error('missing ok');
            return value;
          },
        }),
      );

    await workflowClient.trigger({ url: `${BASE}/api/wf/non-retryable` });
    expect(await (await deliver(app, lastPublished())).json()).toMatchObject({ status: 'failed' });

    await workflowClient.trigger({ body: { ok: false }, url: `${BASE}/api/wf/parsed` });
    expect(await (await deliver(app, lastPublished())).json()).toMatchObject({ status: 'failed' });
    expect(failureFunction).toHaveBeenCalledTimes(2);
    expect(failureFunction.mock.calls[1][0].context.requestPayload).toEqual({ ok: false });
  });

  it('sleeps by handing the run to a delayed continuation', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const after = vi.fn();
    const app = new Hono().post(
      '/api/wf/sleep',
      serve(async (context) => {
        await context.sleep('wait', '3m');
        await context.run('after', after);
      }),
    );
    await workflowClient.trigger({ url: `${BASE}/api/wf/sleep` });
    const trigger = lastPublished();

    const first = await deliver(app, trigger);
    expect(first.status).toBe(202);
    const continuation = lastPublished();
    expect(continuation).toMatchObject({ delay: 180 });
    expect(continuation.body.workflow.seq).toBe(1);
    expect(continuation.deduplicationId).toBe(`${trigger.body.workflow.runId}:1`);

    vi.setSystemTime(1_000_000 + 60_000);
    expect((await deliver(app, continuation)).status).toBe(202);
    expect(lastPublished()).toMatchObject({ delay: 120 });

    vi.setSystemTime(1_000_000 + 180_000);
    expect(await (await deliver(app, lastPublished())).json()).toMatchObject({ status: 'done' });
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('hands over to a fresh delivery once one has worked past its budget', async () => {
    vi.useFakeTimers({ now: 0 });
    const steps = vi.fn();
    const app = new Hono().post(
      '/api/wf/budget',
      serve(async (context) => {
        await context.run('slow', () => {
          vi.setSystemTime(Date.now() + 6 * 60_000);
          steps('slow');
        });
        await context.run('next', () => steps('next'));
      }),
    );
    await workflowClient.trigger({ url: `${BASE}/api/wf/budget` });

    expect((await deliver(app, lastPublished())).status).toBe(202);
    expect(steps.mock.calls).toEqual([['slow']]);
    expect(await (await deliver(app, lastPublished())).json()).toMatchObject({ status: 'done' });
    expect(steps.mock.calls).toEqual([['slow'], ['next']]);
  });

  it('throttles a run over its flow-control parallelism and lets it in once the slot frees', async () => {
    const key = unique('per-user');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = new Hono().post(
      '/api/wf/flow',
      serve(async (context) => {
        await context.run('work', async () => {
          if ((context.requestPayload as { first?: boolean } | undefined)?.first) await gate;
        });
      }),
    );

    await workflowClient.trigger({
      body: { first: true },
      flowControl: { key, parallelism: 1 },
      url: `${BASE}/api/wf/flow`,
    });
    const first = lastPublished();
    await workflowClient.trigger({
      flowControl: { key, parallelism: 1 },
      url: `${BASE}/api/wf/flow`,
    });
    const second = lastPublished();

    const running = deliver(app, first);
    await vi.waitFor(async () => {
      const throttled = await deliver(app, second);
      expect(await throttled.json()).toMatchObject({ status: 'throttled' });
    });
    const retry = lastPublished();
    expect(retry.body.workflow.seq).toBe(1);
    expect(retry.delay).toBeGreaterThan(0);

    release();
    expect(await (await running).json()).toMatchObject({ status: 'done' });
    expect(await (await deliver(app, retry)).json()).toMatchObject({ status: 'done' });
  });

  it('backs a throttled run off exponentially up to five minutes, and starts over once it gets in', async () => {
    // Every throttled delivery is a new queued task: a fixed short retry turned thousands of
    // waiting runs into tens of thousands of deliveries a minute and starved the server.
    const key = unique('backoff');
    let holders = 0;
    let release = () => {};
    const app = new Hono().post(
      '/api/wf/backoff',
      serve(async (context) => {
        if ((context.requestPayload as { holder?: boolean } | undefined)?.holder) {
          await context.run('hold', async () => {
            holders += 1;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          });
          return;
        }
        await context.run('work', () => 'ok');
        await context.sleep('rest', 1);
        await context.run('after', () => 'ok');
      }),
    );
    const trigger = async (body?: unknown) => {
      await workflowClient.trigger({
        body,
        flowControl: { key, parallelism: 1 },
        url: `${BASE}/api/wf/backoff`,
      });
      return lastPublished();
    };
    /** Starts a holder and resolves once it occupies the only slot. */
    const hold = async () => {
      const before = holders;
      const holding = deliver(app, await trigger({ holder: true }));
      await vi.waitFor(() => expect(holders).toBe(before + 1));
      // Wrapped: returning the pending delivery itself would make `await hold()` wait for it.
      return { holding };
    };
    /** Delivers `message` into a full slot, jitter pinned to its upper bound. */
    const throttle = async (message: (typeof published)[number]) => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.999_999);
      try {
        expect(await (await deliver(app, message)).json()).toMatchObject({ status: 'throttled' });
      } finally {
        random.mockRestore();
      }
      return lastPublished();
    };

    let { holding } = await hold();
    let retry = await throttle(await trigger());
    const delays = [retry.delay];
    for (let index = 0; index < 7; index += 1) {
      retry = await throttle(retry);
      delays.push(retry.delay);
    }
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 300, 300]);
    expect(retry.body.workflow.seq).toBe(8);

    release();
    await holding;
    // It gets in, works, then sleeps; its wake-up meets a new holder and waits from the start.
    expect(await (await deliver(app, retry)).json()).toMatchObject({ status: 'suspended' });
    const wake = lastPublished();
    ({ holding } = await hold());
    expect((await throttle(wake)).delay).toBe(5);

    release();
    await holding;
  });

  it('counts a flow-control key declared by both the trigger and the route once', async () => {
    // process-users declares the same key, with ratePerSecond 1, on both sides. Taking a
    // rate token per declaration made every delivery throttle itself for good.
    const flowControl = { key: unique('process-users'), parallelism: 1, ratePerSecond: 1 };
    const app = new Hono().post(
      '/api/wf/same-key',
      serve(async (context) => context.run('work', async () => 'ok'), { flowControl }),
    );

    await workflowClient.trigger({ flowControl, url: `${BASE}/api/wf/same-key` });

    expect(await (await deliver(app, lastPublished())).json()).toMatchObject({ status: 'done' });
  });

  it('refuses a second delivery of a run while one is executing it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = new Hono().post(
      '/api/wf/lock',
      serve(async (context) => {
        await context.run('slow', () => gate);
      }),
    );
    await workflowClient.trigger({ url: `${BASE}/api/wf/lock` });
    const trigger = lastPublished();

    const running = deliver(app, trigger);
    await vi.waitFor(async () => {
      const busy = await deliver(app, trigger, 1);
      expect(busy.status).toBe(409);
      expect(busy.headers.get('Retry-After')).toBe('90');
    });
    release();
    expect((await running).status).toBe(200);
  });

  it('invokes a sibling workflow and resumes with its result', async () => {
    const child = createWorkflow(async (context) => {
      const value = await context.run(
        'compute',
        () => (context.requestPayload as { n: number }).n * 2,
      );
      return { doubled: value };
    });
    const afterInvoke = vi.fn();
    const parent = createWorkflow(async (context) => {
      const result = await context.invoke('call-child', { body: { n: 21 }, workflow: child });
      await context.run('after', () => afterInvoke(result));
      return result;
    });
    const app = new Hono().post('/api/wf/many/:workflowId', serveMany({ child, parent }));

    await workflowClient.trigger({ url: `${BASE}/api/wf/many/parent` });
    const parentTrigger = lastPublished();

    expect((await deliver(app, parentTrigger)).status).toBe(202);
    const childTrigger = lastPublished();
    expect(childTrigger.url).toBe(`${BASE}/api/wf/many/child`);

    // A stray redelivery of the waiting parent neither re-triggers the child nor finishes.
    expect((await deliver(app, parentTrigger, 1)).status).toBe(202);
    expect(published.filter((m) => m.url.endsWith('/child'))).toHaveLength(1);

    expect(await (await deliver(app, childTrigger)).json()).toMatchObject({ status: 'done' });
    const resume = lastPublished();
    expect(resume.url).toBe(`${BASE}/api/wf/many/parent`);
    expect(resume.body.workflow.seq).toBe(1);

    expect(await (await deliver(app, resume)).json()).toMatchObject({ status: 'done' });
    expect(afterInvoke).toHaveBeenCalledWith({
      body: { doubled: 42 },
      isCanceled: false,
      isFailed: false,
    });
  });

  it('stops a canceled run, by id or by URL prefix', async () => {
    const step = vi.fn();
    const app = new Hono().post(
      '/api/wf/cancel/:kind',
      serve(async (context) => {
        await context.run('work', step);
      }),
    );

    const byId = await workflowClient.trigger({ url: `${BASE}/api/wf/cancel/a` });
    const byIdMessage = lastPublished();
    await workflowClient.trigger({ url: `${BASE}/api/wf/cancel/b` });
    const byPrefixMessage = lastPublished();

    expect(await workflowClient.cancel({ ids: [byId.workflowRunId] })).toEqual({ cancelled: 1 });
    expect(await workflowClient.cancel({ urlStartingWith: `${BASE}/api/wf/cancel/` })).toEqual({
      cancelled: 1,
    });

    for (const message of [byIdMessage, byPrefixMessage])
      expect(await (await deliver(app, message)).json()).toMatchObject({ status: 'canceled' });
    expect(step).not.toHaveBeenCalled();
  });

  it('requires a valid signature once a signing key is configured', async () => {
    vi.stubEnv('DELIVERY_SIGNING_KEY', 'workflow-test-key');
    const app = new Hono().post(
      '/api/wf/signed',
      serve(async () => 'ok'),
    );
    await workflowClient.trigger({ url: `${BASE}/api/wf/signed` });
    const trigger = lastPublished();

    expect((await deliver(app, trigger)).status).toBe(401);

    const signature = signUpstashRequest({
      body: JSON.stringify(trigger.body),
      messageId: 'm',
      signingKey: 'workflow-test-key',
      url: trigger.url,
    });
    expect((await deliver(app, trigger, 0, { 'Upstash-Signature': signature })).status).toBe(200);
  });

  it('rejects a body that is not a workflow delivery as non-retryable', async () => {
    const app = new Hono().post(
      '/api/wf/raw',
      serve(async () => 'ok'),
    );
    const response = await app.request(`${BASE}/api/wf/raw`, { body: '{"x":1}', method: 'POST' });
    expect(response.status).toBe(400);
    expect(response.headers.get('Upstash-NonRetryable-Error')).toBe('true');
  });
});
