/** Operator tool: runtime status, verified retirement and external-work reconciliation. */
import 'dotenv/config';

import { Pool } from 'pg';

import { verifyTerminatedProcess } from '../../apps/server/src/modules/Tenant/processIdentity';

const [action, app, argument] = process.argv.slice(2);
if (
  !['lobehub', 'admin'].includes(app) ||
  !['status', 'retire', 'reconcile-external', 'complete-external'].includes(action)
)
  throw new Error(
    'Usage: bun scripts/tenantRuntime/manage.ts status|retire|reconcile-external|complete-external lobehub|admin [process-id]',
  );
const prefix = app === 'admin' ? 'admin_runtime' : 'tenant_runtime';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
try {
  if (action === 'reconcile-external' || action === 'complete-external') {
    if (app !== 'lobehub' || !argument) throw new Error('LOBEHUB_WORK_ID_REQUIRED');
    const { reconcileExternalWork, completeExternalVideo } =
      await import('../../apps/server/src/modules/Tenant/reconcileExternal');
    console.log(
      JSON.stringify(
        await (action === 'reconcile-external'
          ? reconcileExternalWork(argument)
          : completeExternalVideo(argument)),
      ),
    );
  } else if (action === 'status') {
    const processes = await pool.query(
      `SELECT process_id,host,pid,state,started_at,heartbeat_at FROM ${prefix}_process ORDER BY started_at`,
    );
    const claims = await pool.query(
      `SELECT tenant_id,process_id,claimed_version,claimed_at FROM ${prefix}_claim ORDER BY tenant_id`,
    );
    const remote =
      app === 'lobehub'
        ? (
            await pool.query(
              'SELECT work_id,tenant_id,kind,handle,created_at,completed_at FROM tenant_runtime_external_work',
            )
          ).rows
        : [];
    console.log(
      JSON.stringify({ remote, processes: processes.rows, claims: claims.rows }, null, 2),
    );
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const {
        rows: [row],
      } = await client.query(
        `SELECT *, heartbeat_at > now() - interval '15 seconds' AS heartbeat_fresh FROM ${prefix}_process WHERE process_id=$1 FOR UPDATE`,
        [argument],
      );
      if (!row) throw new Error('PROCESS_NOT_FOUND');
      if (row.heartbeat_fresh) throw new Error('RETIRE_HEARTBEAT_STILL_FRESH');
      const evidence = verifyTerminatedProcess({
        pid: row.pid,
        hostId: row.host_id,
        bootId: row.boot_id,
        pidNs: row.pid_ns,
        pidStartTicks: row.pid_start_ticks,
      });
      await client.query(
        `UPDATE ${prefix}_process SET state='retired',retired_at=now(),retired_evidence=$2 WHERE process_id=$1`,
        [argument, JSON.stringify(evidence)],
      );
      await client.query(`DELETE FROM ${prefix}_claim WHERE process_id=$1`, [argument]);
      console.log(JSON.stringify({ processId: argument, evidence }));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
