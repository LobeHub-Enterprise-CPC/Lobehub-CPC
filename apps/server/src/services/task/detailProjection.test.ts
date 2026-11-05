import type { TaskItem } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { projectTaskDetailState } from './detailProjection';

const task = (error: string | null, lastError?: { errorType?: string; message: string }) =>
  ({
    archivedAt: null,
    context: lastError
      ? { lifecycle: { lastError: { at: '2026-11-05T00:50:31Z', ...lastError } } }
      : {},
    error,
    heartbeatInterval: null,
    heartbeatTimeout: null,
    lastHeartbeatAt: null,
    schedulePattern: null,
    scheduleTimezone: null,
  }) as unknown as TaskItem;

describe('projectTaskDetailState errorType', () => {
  it('returns the type of the failure the task currently shows', () => {
    const state = projectTaskDetailState(
      task('A database operation failed.', {
        errorType: 'DatabasePersistError',
        message: 'A database operation failed.',
      }),
      undefined,
    );

    expect(state.errorType).toBe('DatabasePersistError');
  });

  it('does not lend an earlier failure type to a different error', () => {
    // A failed kickoff rewrites `error` without touching the audit.
    const state = projectTaskDetailState(
      task('Agent not found', { errorType: 'DatabasePersistError', message: 'old failure' }),
      undefined,
    );

    expect(state.errorType).toBeUndefined();
  });

  it('returns no type once the error is cleared', () => {
    const state = projectTaskDetailState(
      task(null, { errorType: 'DatabasePersistError', message: 'old failure' }),
      undefined,
    );

    expect(state.errorType).toBeUndefined();
  });
});
