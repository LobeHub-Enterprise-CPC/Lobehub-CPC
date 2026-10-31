// @vitest-environment node
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as StepDrain from '@/server/modules/AgentRuntime/stepDrain';

import type * as Worker from './worker';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  actionWork: vi.fn(),
  sdkHandlers: [] as Array<(...args: any[]) => void>,
  finishWorkers: [] as Array<() => void>,
  /** Rejects a worker's start(), as SDK 1.45.0 does once its listener stops retrying. */
  failWorkers: [] as Array<(error: Error) => void>,
  failRegistrations: 0,
  skipSdkRegistration: false,
  duringRegistration: undefined as (() => void) | undefined,
  probeStatus: [] as Array<number | 'error'>,
  workers: [] as Array<{
    name: string;
    _internal: {
      killing: boolean;
      /** Replaced by the worker's tracking wrapper once started. */
      handleAction: (action: unknown) => Promise<unknown>;
      listener: { stopStream: ReturnType<typeof vi.fn> };
    };
    pause: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@/envs/app', () => ({
  appEnv: { APP_URL: 'https://app.example.com', INTERNAL_APP_URL: 'http://cpc-internal:3210' },
}));

vi.mock('@/server/modules/Tenant/postgresClaims', () => ({
  tenantProcessLease: { ensure: mocks.ensure },
}));

vi.mock('./tasks', () => ({
  getAgentStepTask: () => ({ name: 'cpc-agent-step' }),
  getDeliveryTask: () => ({ name: 'cpc-delivery' }),
}));

// The SDK registers its own SIGTERM/SIGINT handlers while constructing a worker.
const require = createRequire(import.meta.url);
const sdkDir = path.dirname(require.resolve('@hatchet-dev/typescript-sdk/v1'));
const { InternalWorker } = require(path.join(sdkDir, 'client/worker/worker-internal.js'));
const sdkVersion = require(path.join(sdkDir, '../package.json')).version;
vi.mock('./client', () => ({
  getHatchetClient: () => ({
    worker: vi.fn(async (name: string) => {
      const before = new Set([...process.listeners('SIGTERM'), ...process.listeners('SIGINT')]);
      if (!mocks.skipSdkRegistration)
        new InternalWorker(
          { config: { logger: () => ({}), namespace: '' } },
          { name, slots: 1, handleKill: false },
        );
      mocks.sdkHandlers.push(
        ...[...process.listeners('SIGTERM'), ...process.listeners('SIGINT')].filter(
          (fn) => !before.has(fn),
        ),
      );
      // Interception can suppress registration entirely; capture calls separately below.
      await Promise.resolve();
      mocks.duringRegistration?.();
      if (mocks.failRegistrations > 0) {
        mocks.failRegistrations -= 1;
        throw new Error('Could not register workflow: UNAVAILABLE');
      }
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const stopped = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      mocks.finishWorkers.push(finish);
      mocks.failWorkers.push(fail);
      const worker = {
        name,
        _internal: {
          killing: false,
          handleAction: vi.fn(() => mocks.actionWork()),
          listener: { stopStream: vi.fn(() => finish()) },
        },
        pause: vi.fn(async () => {}),
        start: vi.fn(() => stopped),
        stop: vi.fn(async () => {}),
      };
      mocks.workers.push(worker);
      return worker;
    }),
  }),
}));

vi.mock('node:http', () => ({
  request: (url: URL, options: { headers: Record<string, string> }, onResponse: any) => {
    const req = new EventEmitter() as EventEmitter & { destroy: () => void; end: () => void };
    req.destroy = () => {};
    req.end = () => {
      const next = mocks.probeStatus.shift() ?? 200;
      setTimeout(() => {
        if (next === 'error') req.emit('error', new Error('ECONNREFUSED'));
        else onResponse({ resume: () => {}, statusCode: next });
      }, 0);
    };
    return req;
  },
}));

type Modules = {
  drain: typeof StepDrain;
  worker: typeof Worker;
};

const load = async (): Promise<Modules> => {
  vi.resetModules();
  const [drain, worker] = await Promise.all([
    import('@/server/modules/AgentRuntime/stepDrain'),
    import('./worker'),
  ]);
  return { drain, worker };
};

const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('startHatchetWorkers', () => {
  const ownSigterm = () => {};
  let info: ReturnType<typeof vi.spyOn>;

  // The first import transforms the whole module graph; keep that off the first test's clock.
  beforeAll(async () => {
    await import('./worker');
  }, 60_000);

  beforeEach(() => {
    vi.useFakeTimers();
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    mocks.actionWork.mockReset();
    mocks.actionWork.mockResolvedValue(undefined);
    mocks.ensure.mockReset();
    mocks.ensure.mockResolvedValue(undefined);
    mocks.sdkHandlers = [];
    mocks.finishWorkers = [];
    mocks.failWorkers = [];
    mocks.failRegistrations = 0;
    mocks.skipSdkRegistration = false;
    mocks.duringRegistration = undefined;
    Reflect.deleteProperty(globalThis, Symbol.for('lobehub.agentStepDrain'));
    mocks.probeStatus = [];
    mocks.workers = [];
    process.on('SIGTERM', ownSigterm);
  });

  afterEach(async () => {
    mocks.finishWorkers.forEach((finish) => finish());
    await Promise.resolve();
    await Promise.resolve();
    vi.useRealTimers();
    info.mockRestore();
    process.removeListener('SIGTERM', ownSigterm);
    for (const handler of mocks.sdkHandlers) {
      process.removeListener('SIGTERM', handler);
      process.removeListener('SIGINT', handler);
    }
  });

  it('registers the tasks at once but starts the workers only when the server answers', async () => {
    const { worker } = await load();
    mocks.probeStatus = ['error', 503];

    worker.startHatchetWorkers();

    // Two failed probes, 500ms apart, before the third one answers.
    await flush(400);
    expect(mocks.workers).toHaveLength(2);
    for (const w of mocks.workers) expect(w.start).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    await flush(1100);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.workers.map((w) => w.name)).toEqual([
      expect.stringMatching(/^cpc-steps-/),
      expect.stringMatching(/^cpc-delivery-/),
    ]);
    for (const w of mocks.workers) expect(w.start).toHaveBeenCalledTimes(1);
  });

  it('SDK 1.45.0 installs its signal handlers directly during construction', () => {
    expect(sdkVersion).toBe('1.45.0');
    const beforeTerm = new Set(process.listeners('SIGTERM'));
    const beforeInt = new Set(process.listeners('SIGINT'));
    new InternalWorker(
      { config: { logger: () => ({}), namespace: '' } },
      { name: 'signal-contract', slots: 1, handleKill: false },
    );
    const term = process.listeners('SIGTERM').filter((listener) => !beforeTerm.has(listener));
    const int = process.listeners('SIGINT').filter((listener) => !beforeInt.has(listener));
    try {
      expect(term).toHaveLength(1);
      expect(int).toHaveLength(1);
      expect(term[0].toString()).toContain('this.exitGracefully(this.handle_kill)');
      expect(int[0].toString()).toContain('this.exitGracefully(this.handle_kill)');
    } finally {
      for (const listener of term) process.removeListener('SIGTERM', listener);
      for (const listener of int) process.removeListener('SIGINT', listener);
    }
  });

  it('warns when the SDK signal interception misses during worker creation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.skipSdkRegistration = true;
    const { worker } = await load();
    worker.startHatchetWorkers();
    await flush(10);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'hatchet.worker.signal_intercept_miss' }),
    );
    warn.mockRestore();
  });

  it('warns if an SDK signal registration escapes interception', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listener = () => {};
    const register = new Function(
      'listener',
      'process.once("SIGTERM", listener);\n//# sourceURL=/node_modules/@hatchet-dev/typescript-sdk/new-worker.js',
    );
    mocks.duringRegistration = () => {
      register(listener);
      mocks.duringRegistration = undefined;
    };
    try {
      const { worker } = await load();
      worker.startHatchetWorkers();
      await flush(10);
      expect(process.listeners('SIGTERM')).toContain(listener);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'hatchet.worker.signal_intercept_miss' }),
      );
    } finally {
      process.removeListener('SIGTERM', listener);
      warn.mockRestore();
    }
  });

  it('leaves no SDK signal handler behind and keeps the existing ones', async () => {
    const { worker } = await load();
    expect(sdkVersion).toBe('1.45.0');

    worker.startHatchetWorkers();
    await flush(10);

    expect(mocks.workers).toHaveLength(2);
    expect(
      process
        .listeners('SIGTERM')
        .filter((fn) => fn.toString().includes('this.exitGracefully(this.handle_kill)')),
    ).toHaveLength(0);
    expect(
      process
        .listeners('SIGINT')
        .filter((fn) => fn.toString().includes('this.exitGracefully(this.handle_kill)')),
    ).toHaveLength(0);
    expect(process.listeners('SIGTERM')).toContain(ownSigterm);
  });

  it('preserves a listener registered concurrently with asynchronous SDK creation', async () => {
    const { worker } = await load();
    const concurrent = () => {};
    mocks.duringRegistration = () => {
      process.on('SIGTERM', concurrent);
      mocks.duringRegistration = undefined;
    };
    try {
      worker.startHatchetWorkers();
      await flush(10);
      expect(process.listeners('SIGTERM')).toContain(concurrent);
      expect(
        process
          .listeners('SIGTERM')
          .filter((fn) => fn.toString().includes('this.exitGracefully(this.handle_kill)')),
      ).toHaveLength(0);
      expect(
        process
          .listeners('SIGINT')
          .filter((fn) => fn.toString().includes('this.exitGracefully(this.handle_kill)')),
      ).toHaveLength(0);
    } finally {
      process.removeListener('SIGTERM', concurrent);
    }
  });

  it('keeps asking for the tenant process lease before taking deliveries', async () => {
    const { worker } = await load();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.ensure.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);

    worker.startHatchetWorkers();
    await flush(10);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.workers).toHaveLength(2);
    for (const w of mocks.workers) expect(w.start).not.toHaveBeenCalled();

    await flush(5000);
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
    expect(mocks.workers).toHaveLength(2);
    for (const w of mocks.workers) expect(w.start).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('keeps registering while the engine is unreachable', async () => {
    const { worker } = await load();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.failRegistrations = 2;

    worker.startHatchetWorkers();
    await flush(10);
    expect(mocks.workers).toHaveLength(0);

    await flush(10_100);
    expect(mocks.workers).toHaveLength(2);
    for (const w of mocks.workers) expect(w.start).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('does not start workers once the process is draining', async () => {
    const { drain, worker } = await load();
    mocks.probeStatus = ['error'];

    worker.startHatchetWorkers();
    await flush(10);
    const drained = drain.drainAgentSteps();
    await flush(1000);
    await drained;

    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.workers).toHaveLength(2);
    for (const w of mocks.workers) expect(w.start).not.toHaveBeenCalled();
  });

  it('stops both workers when the process drains', async () => {
    const { drain, worker } = await load();

    worker.startHatchetWorkers();
    await flush(10);
    await drain.drainAgentSteps();

    expect(mocks.workers).toHaveLength(2);
    for (const w of mocks.workers) expect(w.stop).toHaveBeenCalledTimes(1);
  });
  it('finishes an action arriving during stop before unregistering the worker', async () => {
    const { drain, worker } = await load();
    worker.startHatchetWorkers();
    await flush(10);
    const target = mocks.workers[0];
    let finishAction!: () => void;
    const action = new Promise<void>((resolve) => {
      finishAction = resolve;
    });
    mocks.actionWork.mockReturnValue(action);
    // A buffered action is delivered while the listener is being closed, after
    // pause succeeds. The receive loop ends before its action handler finishes.
    let delivered = false;
    const deliverBufferedAction = () => {
      if (!delivered) {
        delivered = true;
        void target._internal.handleAction({});
      }
      mocks.finishWorkers[0]();
    };
    target._internal.listener.stopStream.mockImplementation(() => {
      setTimeout(deliverBufferedAction, 0);
    });
    target.stop.mockImplementation(async () => deliverBufferedAction());
    let done = false;
    const drained = drain.drainAgentSteps().then(() => {
      done = true;
    });
    await flush(10);
    expect(done).toBe(false);
    expect(target.stop).not.toHaveBeenCalled();
    finishAction();
    await drained;
    expect(target.stop).toHaveBeenCalledOnce();
  });

  it('pauses both workers before stopping them', async () => {
    const { drain, worker } = await load();
    worker.startHatchetWorkers();
    await flush(10);
    await drain.drainAgentSteps();
    expect(mocks.workers).toHaveLength(2);
    for (const w of mocks.workers) {
      expect(w.pause).toHaveBeenCalledTimes(1);
      expect(w.pause.mock.invocationCallOrder[0]).toBeLessThan(w.stop.mock.invocationCallOrder[0]);
    }
  });

  it('retries a failed pause before stopping and never restarts during drain', async () => {
    const { drain, worker } = await load();
    worker.startHatchetWorkers();
    await flush(10);
    const target = mocks.workers[0];
    target.pause.mockRejectedValueOnce(new Error('temporary outage'));
    const drained = drain.drainAgentSteps();
    await flush(10);
    expect(target.stop).not.toHaveBeenCalled();
    worker.startHatchetWorkers();
    await flush(1100);
    await drained;
    expect(target.pause).toHaveBeenCalledTimes(2);
    expect(target.stop).toHaveBeenCalledTimes(1);
    expect(mocks.workers).toHaveLength(2);
    for (const w of mocks.workers) expect(w.start).toHaveBeenCalledTimes(1);
  });

  it.each(['reject', 'hang'])('warns and stops when pause continues to %s', async (failure) => {
    const { drain, worker } = await load();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    worker.startHatchetWorkers();
    await flush(10);
    const target = mocks.workers[0];
    target.pause.mockImplementation(() =>
      failure === 'reject' ? Promise.reject(new Error('outage')) : new Promise(() => {}),
    );
    const drained = drain.drainAgentSteps();
    await flush(30_000);
    await drained;
    expect(target.stop).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'hatchet.worker.pause_failed' }),
    );
    warn.mockRestore();
  });

  it('warns when its own server does not answer the readiness probe, at once and then periodically', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { worker } = await load();
    // 61 failed probes, 500ms apart, then the server answers.
    mocks.probeStatus = ['error', ...Array.from({ length: 60 }, () => 503)];
    const notReady = () =>
      warn.mock.calls
        .map(([entry]) => entry)
        .filter((entry) => entry?.event === 'hatchet.worker.not_ready');

    worker.startHatchetWorkers();
    await flush(10);
    expect(notReady()).toEqual([
      expect.objectContaining({
        error: 'ECONNREFUSED',
        failedProbes: 1,
        host: 'app.example.com',
        url: expect.stringMatching(/^http:\/\/.+\/api\/version$/),
      }),
    ]);

    await flush(29_900);
    expect(notReady()).toHaveLength(1);
    await flush(200);
    expect(notReady()).toHaveLength(2);
    expect(notReady()[1]).toEqual(
      expect.objectContaining({ failedProbes: 61, host: 'app.example.com', status: 503 }),
    );

    await flush(600);
    expect(mocks.workers).toHaveLength(2);
    for (const w of mocks.workers) expect(w.start).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('registers and starts a replacement once a worker gives up on the engine', async () => {
    const { drain, worker } = await load();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    worker.startHatchetWorkers();
    await flush(10);
    expect(mocks.workers).toHaveLength(2);
    const [steps, deliveries] = mocks.workers;

    // SDK 1.45.0 after an engine outage of a few minutes: start() rejects for good.
    mocks.failWorkers[0](
      new Error('Could not run worker: Could not subscribe to the worker after 20 retries'),
    );
    await flush(10);
    expect(mocks.workers).toHaveLength(2);
    await flush(5000);
    expect(mocks.workers).toHaveLength(3);
    const replacement = mocks.workers[2];
    expect(replacement.name).toBe(steps.name);
    expect(replacement.start).toHaveBeenCalledTimes(1);
    expect(deliveries.start).toHaveBeenCalledTimes(1);
    // The dead worker unregisters once the actions it accepted finish.
    expect(steps.stop).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'hatchet.worker.restarting', worker: steps.name }),
    );

    // The drain stops the replacement, after the actions it accepted.
    let finishAction!: () => void;
    mocks.actionWork.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishAction = resolve;
      }),
    );
    void replacement._internal.handleAction({});
    let done = false;
    const drained = drain.drainAgentSteps().then(() => {
      done = true;
    });
    await flush(10);
    expect(done).toBe(false);
    expect(replacement._internal.killing).toBe(true);
    expect(replacement.stop).not.toHaveBeenCalled();
    finishAction();
    await drained;
    expect(replacement.pause).toHaveBeenCalledTimes(1);
    expect(replacement.stop).toHaveBeenCalledTimes(1);
    expect(deliveries.stop).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('does not replace a worker that fails while the process drains', async () => {
    const { drain, worker } = await load();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    worker.startHatchetWorkers();
    await flush(10);
    expect(mocks.workers).toHaveLength(2);
    // The receive loop errors out as shutdown closes it.
    mocks.workers[0]._internal.listener.stopStream.mockImplementation(() =>
      mocks.failWorkers[0](new Error('Could not run worker: stream reset')),
    );

    await drain.drainAgentSteps();
    await flush(10_000);

    expect(mocks.workers).toHaveLength(2);
    for (const w of mocks.workers) expect(w.stop).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('drops a replacement still waiting to register once the process drains', async () => {
    const { drain, worker } = await load();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    worker.startHatchetWorkers();
    await flush(10);
    expect(mocks.workers).toHaveLength(2);

    mocks.failWorkers[0](
      new Error('Could not run worker: Could not subscribe to the worker after 20 retries'),
    );
    await flush(10);
    await drain.drainAgentSteps();
    await flush(10_000);

    expect(mocks.workers).toHaveLength(2);
    expect(mocks.workers[1].stop).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
