import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { channelAudit, channelJobs, channelRuns, channelSessions } from '../privateSchemas/channel';
import type { Transaction } from '../type';

/** Internal transaction helpers. The caller must hold the owner-scoped Channel row lock. */

/** The next delivery in this scope starts a new native session from a reconstructed snapshot. */
export async function rotateSession(tx: Transaction, session: typeof channelSessions.$inferSelect) {
  await tx
    .update(channelSessions)
    .set({ scope: `archived:${session.id}` })
    .where(eq(channelSessions.id, session.id));
  await tx.insert(channelSessions).values({
    id: `chn_session_${randomUUID()}`,
    channelId: session.channelId,
    memberId: session.memberId,
    scope: session.scope,
    generation: session.generation + 1,
  });
}

/**
 * Logical isolation of a writer whose termination could not be confirmed in time. Its
 * publication is revoked, a job its lost executor left open is settled as failed, and the
 * native session it may still be attached to is retired, so the member can run again from a
 * reconstructed snapshot. It never claims the writer or its tools stopped: `writerReleased`
 * and `physicalStopped` change only on a later physical confirmation.
 */
export async function isolateWriter(
  tx: Transaction,
  run: typeof channelRuns.$inferSelect,
  reason: string,
) {
  if (run.writerReleased || run.isolatedAt) return false;
  const [job] = await tx
    .select({ status: channelJobs.status })
    .from(channelJobs)
    .where(eq(channelJobs.id, run.jobId));
  const jobStatus = job && ['queued', 'running'].includes(job.status) ? 'failed' : job?.status;
  if (jobStatus !== job?.status)
    await tx.update(channelJobs).set({ status: 'failed' }).where(eq(channelJobs.id, run.jobId));
  await tx
    .update(channelRuns)
    .set({ isolatedAt: new Date(), publicationRevoked: true })
    .where(eq(channelRuns.id, run.id));
  const [session] = await tx
    .select()
    .from(channelSessions)
    .where(eq(channelSessions.id, run.sessionId));
  if (session && !session.scope.startsWith('archived:')) await rotateSession(tx, session);
  await tx.insert(channelAudit).values({
    id: `chn_audit_${randomUUID()}`,
    channelId: run.channelId,
    event: 'execution_isolated',
    targetId: run.id,
    details: { reason, status: run.status, jobStatus, physicalStopped: run.physicalStopped },
  });
  return true;
}
