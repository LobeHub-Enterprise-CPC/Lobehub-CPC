/** Operator tool: status, verified retirement, or explicit legacy-worker cutover. */
import 'dotenv/config';

import { readFileSync } from 'node:fs';

import { Pool } from 'pg';

import { verifyTerminatedProcess } from '../../apps/server/src/modules/Tenant/processIdentity';

const [action, app, argument, buildRef] = process.argv.slice(2);
if (
  !['lobehub', 'admin'].includes(app) ||
  !['status', 'retire', 'cutover', 'reconcile-external', 'complete-external'].includes(action)
)
  throw new Error(
    'Usage: bun scripts/tenantRuntime/manage.ts status|retire|cutover|reconcile-external|complete-external lobehub|admin [process-id|evidence-file] [build-ref]',
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
    const cutover = await pool.query(`SELECT enforced_at,build_ref FROM ${prefix}_cutover`);
    const remote =
      app === 'lobehub'
        ? (
            await pool.query(
              'SELECT work_id,tenant_id,kind,handle,created_at,completed_at FROM tenant_runtime_external_work',
            )
          ).rows
        : [];
    console.log(
      JSON.stringify(
        { remote, processes: processes.rows, claims: claims.rows, cutover: cutover.rows },
        null,
        2,
      ),
    );
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (action === 'retire') {
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
      } else {
        if (!argument || !buildRef)
          throw new Error(
            'Cutover requires an evidence file proving legacy replicas stopped, and a build reference',
          );
        const evidence = readFileSync(argument, 'utf8').trim();
        if (evidence.length < 20) throw new Error('CUTOVER_EVIDENCE_REQUIRED');
        await client.query(
          `INSERT INTO ${prefix}_cutover(id,enforced_at,evidence,build_ref) VALUES('strict-stop',now(),$1,$2) ON CONFLICT(id) DO UPDATE SET enforced_at=now(),evidence=excluded.evidence,build_ref=excluded.build_ref`,
          [evidence, buildRef],
        );
        console.log(JSON.stringify({ cutover: app, buildRef }));
      }
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
