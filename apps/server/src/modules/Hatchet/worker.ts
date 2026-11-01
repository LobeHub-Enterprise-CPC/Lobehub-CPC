import { request } from 'node:http';
import { hostname } from 'node:os';

import type { Worker as HatchetWorker } from '@hatchet-dev/typescript-sdk/v1';

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

const READY_POLL_MS = 500;
/** Warn on the first failed readiness probe, then on every this many: about every 30s. */
const READY_WARN_EVERY = 60;
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

interface ProbeFailure {
  error?: string;
  host?: string;
  status?: number;
  url: string;
}

/**
 * One loopback GET of `/api/version` through the same address rules deliveries
 * use. Resolves undefined once it answers 200, otherwise with what was probed
 * and how it failed.
 */
const probeReady = (): Promise<ProbeFailure | undefined> => {
  const target = resolveDeliveryTarget(new URL('/api/version', appEnv.APP_URL).toString(), {
    agentRuntimeBaseUrl: process.env.AGENT_RUNTIME_BASE_URL,
    appUrl: appEnv.APP_URL,
    hostname: process.env.HOSTNAME,
    internalAppUrl: appEnv.INTERNAL_APP_URL || appEnv.APP_URL,
    port: process.env.PORT ?? '3210',
  });
  if (!target.loopback)
    return Promise.resolve({ error: 'not a loopback address', url: target.url.href });

  const probed = { host: target.host, url: target.url.href };
  return new Promise((resolve) => {
    const req = request(
      target.url,
      { headers: { host: target.host }, method: 'GET', timeout: READY_PROBE_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200 ? undefined : { ...probed, status: res.statusCode });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no answer in ${READY_PROBE_TIMEOUT_MS}ms`)));
    req.on('error', (error) => resolve({ ...probed, error: error.message }));
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

/** One kind of worker, steps or deliveries, and whichever worker currently serves it. */
interface Role {
  /** Accepted actions not finished yet, of this role's current and earlier workers. */
  pending: Set<Promise<unknown>>;
  /** The current worker's start(): settles once its receive loop has ended. */
  receiver?: Promise<void>;
  /** Registers a worker for this role; undefined once the process drains. */
  register: () => Promise<HatchetWorker | undefined>;
  worker: HatchetWorker;
}

/**
 * Starts `worker` as `role`'s current worker. SDK 1.45.0's listener stops
 * retrying a lost engine after about 3.5 minutes and start() then rejects:
 * that worker takes nothing more, so unless the process drains, a
 * replacement is registered and started the same way.
 */
const run = (role: Role, worker: HatchetWorker): void => {
  // Track the whole action, including the dispatcher completion acknowledgement.
  // SDK 1.45's stop snapshots futures while the receive loop is still live;
  // a buffered action delivered afterwards can otherwise outlive unregister.
  const handleAction = worker._internal.handleAction.bind(worker._internal);
  worker._internal.handleAction = (action) => {
    const result = handleAction(action);
    role.pending.add(result);
    const forget = () => role.pending.delete(result);
    void result.then(forget, forget);
    return result;
  };
  role.worker = worker;
  role.receiver = withoutSdkSignalHandlers(() => worker.start()).catch((error: unknown) => {
    console.error('[Hatchet] worker stopped', error);
    if (isDrainingAgentSteps()) return;
    console.info({ event: 'hatchet.worker.restarting', worker: worker.name });
    // Its heartbeat outlives the listener: stop() unregisters the worker once
    // the actions it accepted have finished.
    worker.stop().catch((stopError: unknown) => {
      console.error('[Hatchet] could not stop worker', stopError);
    });
    void (async () => {
      // Not at once: a start() that keeps failing straight away must not spin.
      await sleep(WORKER_RETRY_MS);
      const replacement = await role.register();
      if (replacement && !isDrainingAgentSteps()) run(role, replacement);
    })().catch((restartError: unknown) => {
      console.error('[Hatchet] could not restart worker', restartError);
    });
  });
  console.info({ event: 'hatchet.worker.started', worker: worker.name });
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
    const registration = (name: string, slots: number, task: DeliveryTask) => () =>
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
    const roles: Role[] = [];
    for (const register of [
      registration(`cpc-steps-${id}`, capacity.stepSlots, getAgentStepTask()),
      registration(`cpc-delivery-${id}`, capacity.deliverySlots, getDeliveryTask()),
    ]) {
      const worker = await register();
      if (!worker) return;
      roles.push({ pending: new Set(), register, worker });
    }

    // A worker that was never started has nothing to stop.
    let running = false;
    registerDrainParticipant({
      stop: async () => {
        if (!running) return;
        await Promise.allSettled(
          roles.map(async ({ pending, receiver, worker }) => {
            await pauseBeforeStop(worker);
            // Close admission but keep the heartbeat and worker registration
            // alive until every accepted action has sent its terminal event.
            // killing also fences start() if listener registration is pending.
            worker._internal.killing = true;
            worker._internal.listener?.stopStream();
            await receiver;
            while (pending.size > 0) await Promise.allSettled(pending);
            await worker.stop();
            console.info({ event: 'hatchet.worker.stopped', worker: worker.name });
          }),
        );
      },
    });

    let failedProbes = 0;
    const ready = await retryUntilDraining(async () => {
      const failure = await probeReady();
      if (!failure) return true;
      // Nothing is consumed until this server answers: say so at once, then periodically.
      failedProbes += 1;
      if ((failedProbes - 1) % READY_WARN_EVERY === 0)
        console.warn({ event: 'hatchet.worker.not_ready', failedProbes, ...failure });
      return undefined;
    }, READY_POLL_MS);
    if (!ready) return;
    console.info({ event: 'hatchet.worker.loopback_ready', failedProbes });

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
    for (const role of roles) run(role, role.worker);
  })().catch((error) => {
    console.error('[Hatchet] failed to start workers', error);
  });
};
