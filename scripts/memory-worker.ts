import { once } from 'node:events';
import { createServer } from 'node:http';

/**
 * Memory worker: serves `cpc-memory-delivery` runs (every memory workflow delivery in queue
 * mode) in this process instead of the web pods, so memory extraction scales and rolls out
 * on its own. Start it before web pods that route memory deliveries here. SIGTERM pauses the worker, waits for the deliveries it
 * accepted, then deregisters (tenant process lease).
 */
async function main() {
  const check = process.argv.includes('--check');
  const [
    { isDrainingAgentSteps },
    { isHatchetDeliveryEnabled },
    { startMemoryDeliveryWorker },
    { tenantProcessLease },
  ] = await Promise.all([
    import('../apps/server/src/modules/AgentRuntime/stepDrain'),
    import('../apps/server/src/modules/Hatchet/config'),
    import('../apps/server/src/modules/Hatchet/worker'),
    import('../apps/server/src/modules/Tenant/postgresClaims'),
    // Fails the check if the memory routes cannot load outside Next.
    import('../apps/server/src/modules/Hatchet/memoryDelivery'),
  ]);
  if (check) {
    console.info('[memory-worker] Runtime imports OK');
    return 0;
  }
  if (!isHatchetDeliveryEnabled()) {
    console.info('[memory-worker] Disabled: memory deliveries need AGENT_RUNTIME_MODE=queue');
    return 0;
  }

  const leaseHeld = () => {
    try {
      tenantProcessLease.assertValid();
      return true;
    } catch {
      return false;
    }
  };
  // The tenant process lease drains on SIGTERM, deregisters and signals again; it also
  // signals when it fences itself. Exit once it no longer holds the process: at once if it
  // never did (nothing was accepted yet), after the drain otherwise.
  let exiting = false;
  let started = false;
  process.on('SIGTERM', () => {
    if (exiting) return;
    exiting = true;
    const exitWhenReleased = () => {
      if (leaseHeld()) return;
      console.info('[memory-worker] Stopped');
      // A fence without a drain is a failure; a drained stop is a clean exit.
      process.exit(isDrainingAgentSteps() || !started ? 0 : 1);
    };
    setInterval(exitWhenReleased, 200);
    exitWhenReleased();
  });

  const { startStallDetector } = await import('../apps/server/src/modules/RuntimeActivity');
  startStallDetector();
  const workers = startMemoryDeliveryWorker();
  started = true;

  const serving = () => workers.isServing() && leaseHeld();
  const health = createServer((request, response) => {
    if (request.url !== '/healthz') {
      response.writeHead(404).end();
      return;
    }
    const ready = serving();
    response.writeHead(ready ? 200 : 503, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    });
    response.end(JSON.stringify({ status: ready ? 'ready' : 'not-ready' }));
  });
  // Never keeps the process up by itself: the Hatchet worker does until it is drained.
  health.unref();
  health.listen(Number(process.env.MEMORY_WORKER_PORT || 3212), '0.0.0.0');
  await once(health, 'listening');
  console.info('[memory-worker] Started');
  return undefined;
}

void main().then(
  (code) => {
    if (code !== undefined) process.exit(code);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
