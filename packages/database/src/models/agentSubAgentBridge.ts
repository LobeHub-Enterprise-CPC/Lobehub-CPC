import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';

import { agentSubAgentBridges, type NewAgentSubAgentBridge } from '../privateSchemas';
import { agentOperations } from '../schemas/agentOperations';
import type { LobeChatDatabase } from '../type';

interface BridgeIdentity {
  completionReason?: 'done' | 'error' | 'interrupted' | 'other';
  leaseOwner?: string;
  parentOperationId: string;
  threadId: string;
  toolMessageId: string;
  userId: string;
}

export class AgentSubAgentBridgeModel {
  constructor(private readonly db: LobeChatDatabase) {}

  async create(values: NewAgentSubAgentBridge): Promise<void> {
    const inserted = await this.db
      .insert(agentSubAgentBridges)
      .values(values)
      .onConflictDoNothing({ target: agentSubAgentBridges.childOperationId })
      .returning({ id: agentSubAgentBridges.id });
    if (inserted.length) return;
    const [existing] = await this.db
      .select()
      .from(agentSubAgentBridges)
      .where(eq(agentSubAgentBridges.childOperationId, values.childOperationId))
      .limit(1);
    if (
      !existing ||
      existing.parentOperationId !== values.parentOperationId ||
      existing.threadId !== values.threadId ||
      existing.toolMessageId !== values.toolMessageId ||
      existing.childRunToken !== values.childRunToken ||
      existing.waitingBatchId !== values.waitingBatchId ||
      existing.userId !== values.userId ||
      existing.workspaceId !== (values.workspaceId ?? null) ||
      existing.includeShareVisitor !== (values.includeShareVisitor ?? false)
    ) {
      throw new Error('Sub-agent bridge identity conflict');
    }
  }

  async markDelivered(childOperationId: string, identity?: BridgeIdentity): Promise<boolean> {
    const conditions = [
      eq(agentSubAgentBridges.childOperationId, childOperationId),
      eq(agentSubAgentBridges.status, 'pending'),
    ];
    if (identity)
      conditions.push(
        eq(agentSubAgentBridges.parentOperationId, identity.parentOperationId),
        eq(agentSubAgentBridges.threadId, identity.threadId),
        eq(agentSubAgentBridges.toolMessageId, identity.toolMessageId),
        eq(agentSubAgentBridges.userId, identity.userId),
      );
    if (identity?.leaseOwner)
      conditions.push(eq(agentSubAgentBridges.leaseOwner, identity.leaseOwner));
    const rows = await this.db
      .update(agentSubAgentBridges)
      .set({
        status: 'delivered',
        completionReason: identity?.completionReason ?? null,
        leaseOwner: null,
        leaseUntil: null,
      })
      .where(and(...conditions))
      .returning({ id: agentSubAgentBridges.id });
    return rows.length > 0;
  }

  listRecoverable({ before, limit, offset }: { before: Date; limit: number; offset: number }) {
    return this.db
      .select()
      .from(agentSubAgentBridges)
      .where(
        and(
          eq(agentSubAgentBridges.status, 'pending'),
          lte(agentSubAgentBridges.updatedAt, before),
        ),
      )
      .orderBy(asc(agentSubAgentBridges.updatedAt), asc(agentSubAgentBridges.id))
      .limit(limit)
      .offset(offset);
  }

  listTerminalRecoverable({
    before,
    cursor,
    limit,
  }: {
    before: Date;
    cursor?: { id: string; updatedAt: Date };
    limit: number;
  }) {
    // Date values crossing the JS boundary have millisecond precision, whereas
    // Postgres timestamps may contain microseconds. Use the same precision on
    // both sides of the cursor to avoid repeating or skipping rows.
    const cursorTime = sql<Date>`date_trunc('milliseconds', ${agentSubAgentBridges.updatedAt})`;
    return this.db
      .select({ binding: agentSubAgentBridges, child: agentOperations })
      .from(agentSubAgentBridges)
      .innerJoin(agentOperations, eq(agentSubAgentBridges.childOperationId, agentOperations.id))
      .where(
        and(
          eq(agentSubAgentBridges.status, 'pending'),
          lte(agentSubAgentBridges.updatedAt, before),
          inArray(agentOperations.status, ['done', 'error', 'interrupted', 'abandoned']),
          cursor
            ? or(
                gt(cursorTime, cursor.updatedAt),
                and(eq(cursorTime, cursor.updatedAt), gt(agentSubAgentBridges.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(cursorTime), asc(agentSubAgentBridges.id))
      .limit(limit);
  }

  async release(childOperationId: string, owner: string): Promise<boolean> {
    const rows = await this.db
      .update(agentSubAgentBridges)
      .set({ leaseOwner: null, leaseUntil: null })
      .where(
        and(
          eq(agentSubAgentBridges.childOperationId, childOperationId),
          eq(agentSubAgentBridges.status, 'pending'),
          eq(agentSubAgentBridges.leaseOwner, owner),
        ),
      )
      .returning({ id: agentSubAgentBridges.id });
    return rows.length > 0;
  }

  async claim(childOperationId: string, owner: string, now: Date, until: Date): Promise<boolean> {
    if (until <= now) throw new Error('Invalid bridge lease');
    const rows = await this.db
      .update(agentSubAgentBridges)
      .set({
        leaseOwner: owner,
        leaseUntil: until,
        attempts: sql`${agentSubAgentBridges.attempts} + 1`,
      })
      .where(
        and(
          eq(agentSubAgentBridges.childOperationId, childOperationId),
          eq(agentSubAgentBridges.status, 'pending'),
          or(isNull(agentSubAgentBridges.leaseUntil), lte(agentSubAgentBridges.leaseUntil, now)),
        ),
      )
      .returning({ id: agentSubAgentBridges.id });
    return rows.length > 0;
  }

  /** Extend a live lease only for its current owner; expired leases cannot be revived. */
  async renew(childOperationId: string, owner: string, now: Date, until: Date): Promise<boolean> {
    if (until <= now) throw new Error('Invalid bridge lease');
    const rows = await this.db
      .update(agentSubAgentBridges)
      .set({ leaseUntil: until })
      .where(
        and(
          eq(agentSubAgentBridges.childOperationId, childOperationId),
          eq(agentSubAgentBridges.status, 'pending'),
          eq(agentSubAgentBridges.leaseOwner, owner),
          lt(sql`${now}`, agentSubAgentBridges.leaseUntil),
        ),
      )
      .returning({ id: agentSubAgentBridges.id });
    return rows.length > 0;
  }

  private async settle(
    childOperationId: string,
    owner: string,
    now: Date,
    status: 'recovered' | 'failed',
    lastError: string | null,
  ): Promise<boolean> {
    const rows = await this.db
      .update(agentSubAgentBridges)
      .set({ status, lastError, leaseOwner: null, leaseUntil: null })
      .where(
        and(
          eq(agentSubAgentBridges.childOperationId, childOperationId),
          eq(agentSubAgentBridges.status, 'pending'),
          eq(agentSubAgentBridges.leaseOwner, owner),
          lt(sql`${now}`, agentSubAgentBridges.leaseUntil),
        ),
      )
      .returning({ id: agentSubAgentBridges.id });
    return rows.length > 0;
  }

  markRecovered(childOperationId: string, owner: string, now: Date): Promise<boolean> {
    return this.settle(childOperationId, owner, now, 'recovered', null);
  }

  markFailed(
    childOperationId: string,
    owner: string,
    now: Date,
    errorCode: string,
  ): Promise<boolean> {
    if (!/^[a-z0-9_]{1,64}$/.test(errorCode)) throw new Error('Invalid bridge error code');
    return this.settle(childOperationId, owner, now, 'failed', errorCode);
  }
}
