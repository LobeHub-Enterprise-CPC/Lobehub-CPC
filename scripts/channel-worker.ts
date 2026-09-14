import { Client } from 'pg';

import { ChannelWorker } from '../apps/server/src/services/channel/worker';
import { serverDB } from '../packages/database/src/server';

async function main() {
  // A coordinator process never diagnoses another live coordinator's Native tools as orphaned.
  const ownership = new Client({ connectionString: process.env.DATABASE_URL });
  await ownership.connect();
  const lock = await ownership.query(
    "select pg_try_advisory_lock(hashtext('channel-coordinator')) as acquired",
  );
  if (!lock.rows[0].acquired) {
    await ownership.end();
    throw new Error('A Channel coordinator is already running');
  }
  const worker = new ChannelWorker(serverDB);
  let stopping = false;
  ownership.on('error', () => {
    stopping = true;
    void worker.close();
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      stopping = true;
    });
  while (!stopping) {
    try {
      await worker.tick();
    } catch (error) {
      console.error('[channel-worker]', error instanceof Error ? error.message : String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await worker.close();
  await ownership.end();
  process.exit(0);
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
