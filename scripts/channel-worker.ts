import { once } from 'node:events';
import { createServer } from 'node:http';

import { Client } from 'pg';

import { getChannelGatewayUrl } from '../apps/server/src/services/channel/gateway';

async function main() {
  const check = process.argv.includes('--check');
  if (!check && !getChannelGatewayUrl()) {
    console.info(
      '[channel-worker] Disabled: CHANNEL_GATEWAY_URL is not configured with a valid HTTP(S) URL',
    );
    return 0;
  }
  // Disabled deployments must not initialize the database or agent runtime.
  const [{ ChannelWorker }, { serverDB }] = await Promise.all([
    import('../apps/server/src/services/channel/worker'),
    import('../packages/database/src/server'),
  ]);
  if (check) {
    console.info('[channel-worker] Runtime imports OK');
    return 0;
  }

  // A coordinator process never diagnoses another live coordinator's Native tools as orphaned.
  const ownership = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
  });
  const worker = new ChannelWorker(serverDB);
  let stopping = false;
  let exitCode = 0;
  let lastSuccess = 0;
  const stop = () => {
    stopping = true;
  };
  const ownershipLost = () => {
    if (stopping) return;
    console.error('[channel-worker] Coordinator database connection lost');
    exitCode = 1;
    stopping = true;
    // Stop new delivery starts and drain preparation. Standard native operations
    // remain owned by the shared runtime and the next coordinator reconciles them.
    void worker.close().catch((error) => console.error('[channel-worker] Drain failed', error));
  };
  ownership.on('error', ownershipLost);
  ownership.on('end', ownershipLost);
  await ownership.connect();
  const health = createServer((request, response) => {
    if (request.url !== '/healthz') {
      response.writeHead(404).end();
      return;
    }
    const ready = !stopping && lastSuccess > 0 && Date.now() - lastSuccess < 30_000;
    response.writeHead(ready ? 200 : 503, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    });
    response.end(JSON.stringify({ status: ready ? 'ready' : 'not-ready' }));
  });

  try {
    const lock = await ownership.query(
      "select pg_try_advisory_lock(hashtext('channel-coordinator')) as acquired",
    );
    if (!lock.rows[0].acquired) throw new Error('A Channel coordinator is already running');

    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
    health.listen(Number(process.env.CHANNEL_WORKER_PORT || 3211), '0.0.0.0');
    await once(health, 'listening');
    console.info('[channel-worker] Coordinator started');
    while (!stopping) {
      try {
        // Missing the bridge migration must keep readiness closed, even before
        // the first native job reaches the runtime.
        await ownership.query(
          'select operation_id from channel_native_operations limit 0; select id from channel_native_effects limit 0',
        );
        await worker.tick();
        lastSuccess = Date.now();
      } catch (error) {
        lastSuccess = 0;
        console.error('[channel-worker]', error instanceof Error ? error.message : String(error));
      }
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    stopping = true;
    // Retain coordinator ownership until all active runs have been drained.
    try {
      await worker.close();
    } finally {
      health.close();
      health.closeAllConnections();
      await ownership.end();
      for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop);
    }
  }
  return exitCode;
}

void main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
