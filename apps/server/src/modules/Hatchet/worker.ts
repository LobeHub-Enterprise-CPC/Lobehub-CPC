import { request } from 'node:http';
import { hostname } from 'node:os';

import debug from 'debug';

import { appEnv } from '@/envs/app';
import {
  isDrainingAgentSteps,
  registerDrainParticipant,
} from '@/server/modules/AgentRuntime/stepDrain';
import { tenantProcessLease } from '@/server/modules/Tenant/postgresClaims';
import { pendingHostWorkCount, settleHostWork } from '@/server/utils/scheduleAfterResponse';

import { resolveDeliveryTarget } from './address';
import { getHatchetClient } from './client';
import { getHatchetCapacity } from './config';
import { pendingPublishCount, settlePendingPublishes } from './pending';
import { type DeliveryTask, getAgentStepTask, getDeliveryTask } from './tasks';

const log = debug('lobe-server:hatchet:worker');

const READY_POLL_MS = 500;
const READY_PROBE_TIMEOUT_MS = 2000;
const LEASE_RETRY_MS = 5000;
const WORKER_RETRY_MS = 5000;
// The deployment already spends 15s in preStop; leave the rest of its grace
// period for SDK shutdown and in-flight work after this bounded pause retry.
const PAUSE_BUDGET_MS = 25_000;
const PAUSE_RETRY_MS = 1000;
const PAUSE_ATTEMPT_TIMEOUT_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pause before SDK shutdown snapshots its in-flight tasks. REST can hang. */
const pauseBeforeStop = async (worker: { name: string; pause: () => Promise<unknown> }) => {
  const deadline = Date.now() + PAUSE_BUDGET_MS;
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        worker.pause(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('pause timed out')),
            Math.min(PAUSE_ATTEMPT_TIMEOUT_MS, deadline - Date.now()),
          );
        }),
      ]);
      return;
    } catch {
      const remaining = deadline - Date.now();
      if (remaining > 0) await sleep(Math.min(PAUSE_RETRY_MS, remaining));
    } finally {
      clearTimeout(timer);
    }
  }
  console.warn({ event: 'hatchet.worker.pause_failed', worker: worker.name });
};

/**
 * SDK 1.45.0 registers signal handlers in InternalWorker's constructor, even
 * with handleKill false. Intercept only that constructor's direct registrations;
 * other work can register its own listeners while worker creation is pending.
 * Keep the interception through start() as legacy engine detection is async.
 */
const withoutSdkSignalHandlers = async <T>(
  fn: () => T | Promise<T>,
  expectRegistration = false,
): Promise<T> => {
  const key = Symbol.for('lobehub.hatchetSignalInterception');
  const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  type Interception = {
    count: number;
    intercepted: number;
    original: typeof process.on;
    wrapped: typeof process.on;
  };
  let state = globals[key] as Interception | undefined;
  if (!state) {
    const original = process.on;
    const wrapped = function (this: NodeJS.Process, ...args: Parameters<typeof process.on>) {
      const [event] = args;
      if (event === 'SIGTERM' || event === 'SIGINT') {
        const stack = new Error('SDK signal registration').stack ?? '';
        const caller = stack.split('\n')[2] ?? '';
        if (
          /new InternalWorker \(.*@hatchet-dev\/typescript-sdk\/v1\/client\/worker\/worker-internal\.js:/.test(
            caller,
          )
        ) {
          state!.intercepted += 1;
          return this;
        }
        if (stack.includes('@hatchet-dev/typescript-sdk')) {
          console.warn({ event: 'hatchet.worker.signal_intercept_miss' });
        }
      }
      return original.apply(this, args);
    } as typeof process.on;
    state = { count: 0, intercepted: 0, original, wrapped };
    globals[key] = state;
    process.on = wrapped;
  }
  state.count += 1;
  const interceptedBefore = state.intercepted;
  try {
    const result = await fn();
    if (expectRegistration && state.intercepted === interceptedBefore) {
      console.warn({ event: 'hatchet.worker.signal_intercept_miss' });
    }
    return result;
  } finally {
    state.count -= 1;
    if (state.count === 0) {
      if (process.on === state.wrapped) process.on = state.original;
      delete globals[key];
    }
  }
};

/** One loopback GET of `/api/version` through the same address rules deliveries use. */
const probeReady = (): Promise<boolean> => {
  const target = resolveDeliveryTarget(new URL('/api/version', appEnv.APP_URL).toString(), {
    agentRuntimeBaseUrl: process.env.AGENT_RUNTIME_BASE_URL,
    appUrl: appEnv.APP_URL,
    hostname: process.env.HOSTNAME,
    internalAppUrl: appEnv.INTERNAL_APP_URL || appEnv.APP_URL,
    port: process.env.PORT ?? '3210',
  });
  if (!target.loopback) return Promise.resolve(false);

  return new Promise((resolve) => {
    const req = request(
      target.url,
      { headers: { host: target.host }, method: 'GET', timeout: READY_PROBE_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
};

/** Retries `attempt` until it yields a value; undefined once the process starts draining. */
const retryUntilDraining = async <T>(
  attempt: () => Promise<T | undefined>,
  intervalMs: number,
): Promise<T | undefined> => {
  while (!isDrainingAgentSteps()) {
    const value = await attempt();
    if (value !== undefined) return value;
    await sleep(intervalMs);
  }
  return undefined;
};

/** Logs and resolves undefined instead of rejecting, so the caller retries. */
const orUndefined = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await fn();
  } catch (error) {
    console.error(`[Hatchet] ${what}`, error);
    return undefined;
  }
};

let started = false;

/**
 * Start this process's Hatchet workers without holding up server start: Next
 * awaits `register()` before it serves requests, and the workers must not take
 * a delivery before this very server answers on its loopback address.
 *
 * Creating a worker registers its task with the engine, which publishing a
 * run needs, so that happens first; the worker takes nothing until started.
 * The tenant process lease owns SIGTERM (drain → deregister → re-signal), so
 * it has to exist before the first delivery, and the drain participants are
 * registered before the workers can accept anything.
 */
export const startHatchetWorkers = (): void => {
  if (started) return;
  started = true;

  // Post-response work and Hatchet publishes are waited for on shutdown even
  // if the workers never come up: request handlers produce both.
  registerDrainParticipant({
    pending: () => pendingHostWorkCount() + pendingPublishCount(),
    settle: async () => {
      await Promise.all([settleHostWork(), settlePendingPublishes()]);
    },
  });

  void (async () => {
    const capacity = getHatchetCapacity();
    const id = `${hostname()}-${process.pid}`;
    const create = (name: string, slots: number, task: DeliveryTask) =>
      retryUntilDraining(
        () =>
          orUndefined(`could not register ${task.name}`, () =>
            withoutSdkSignalHandlers(
              () =>
                getHatchetClient().worker(name, { handleKill: false, slots, workflows: [task] }),
              true,
            ),
          ),
        WORKER_RETRY_MS,
      );
    const steps = await create(`cpc-steps-${id}`, capacity.stepSlots, getAgentStepTask());
    const deliveries =
      steps && (await create(`cpc-delivery-${id}`, capacity.deliverySlots, getDeliveryTask()));
    if (!steps || !deliveries) return;

    // Track the whole action, including the dispatcher completion acknowledgement.
    // SDK 1.45's stop snapshots futures while the receive loop is still live;
    // a buffered action delivered afterwards can otherwise outlive unregister.
    const actions = new Map(
      [steps, deliveries].map((worker) => {
        const pending = new Set<Promise<unknown>>();
        const handleAction = worker._internal.handleAction.bind(worker._internal);
        worker._internal.handleAction = (action) => {
          const result = handleAction(action);
          pending.add(result);
          const forget = () => pending.delete(result);
          void result.then(forget, forget);
          return result;
        };
        return [worker, pending] as const;
      }),
    );
    const receivers = new Map<typeof steps, Promise<void>>();
    // A worker that was never started has nothing to stop.
    let running = false;
    registerDrainParticipant({
      stop: async () => {
        if (!running) return;
        await Promise.allSettled(
          [steps, deliveries].map(async (worker) => {
            await pauseBeforeStop(worker);
            // Close admission but keep the heartbeat and worker registration
            // alive until every accepted action has sent its terminal event.
            // killing also fences start() if listener registration is pending.
            worker._internal.killing = true;
            worker._internal.listener?.stopStream();
            await receivers.get(worker);
            const pending = actions.get(worker)!;
            while (pending.size > 0) await Promise.allSettled(pending);
            await worker.stop();
          }),
        );
      },
    });

    const ready = await retryUntilDraining(
      async () => (await probeReady()) || undefined,
      READY_POLL_MS,
    );
    if (!ready) return;
    log('loopback ready');

    const leased = await retryUntilDraining(
      () =>
        orUndefined('tenant process lease not available yet', async () => {
          await tenantProcessLease.ensure();
          return true;
        }),
      LEASE_RETRY_MS,
    );
    if (!leased || isDrainingAgentSteps()) return;

    running = true;
    for (const worker of [steps, deliveries]) {
      receivers.set(
        worker,
        withoutSdkSignalHandlers(() => worker.start()).catch((error) =>
          console.error('[Hatchet] worker stopped', error),
        ),
      );
    }
    log('workers started: %s', id);
  })().catch((error) => {
    console.error('[Hatchet] failed to start workers', error);
  });
};
