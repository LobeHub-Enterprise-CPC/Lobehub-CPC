import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { buildTaskListFilters } from './taskListFilters';

const sql = (options: Parameters<typeof buildTaskListFilters>[0]) => buildTaskListFilters(options).map((condition) => new PgDialect().sqlToQuery(condition));
describe('scheduled task management filter', () => {
  it('opts management into completed automation without changing live roll-ups', () => {
    const live = sql({ automated: true });
    const management = sql({ automated: true, includeFinishedAutomation: true });
    expect(live[0].sql).toContain('"status" not in');
    expect(management[0].sql).not.toContain('"status"');
    expect(management[0].params).toEqual(['schedule', 'heartbeat']);
    expect(management[1].sql).toContain('"archived_at" is null');
  });
  it('leaves ordinary task semantics and ownership narrowing intact', () => {
    expect(sql({ automated: false, includeFinishedAutomation: true })).toEqual(sql({ automated: false }));
    expect(sql({ automated: true, includeFinishedAutomation: true, assigneeUserId: 'member' })[0].params).toEqual(['member']);
  });
});
