import { describe, expect, it } from 'vitest';

import type { channelService } from '@/services/channel';

import { channelActivity } from './activity';

type Detail = Awaited<ReturnType<typeof channelService.detail>>;
const fixture = (overrides: Record<string, unknown> = {}) =>
  ({
    contextMessages: [],
    members: [
      { id: 'a', name: 'Codex', active: true },
      { id: 'b', name: 'Amp', active: true },
    ],
    messages: [{ id: 'request', threadId: null, authorMemberId: null }],
    jobs: [
      { id: 'j1', memberId: 'a', messageId: 'request', threadId: null, status: 'queued' },
      { id: 'j2', memberId: 'b', messageId: 'request', threadId: 'thread', status: 'running' },
    ],
    runs: [{ jobId: 'j2', status: 'running', activity: 'typing' }],
    ...overrides,
  }) as unknown as Detail;

describe('Channel activity', () => {
  it('keeps queued members distinct from typing and scopes both to their conversation', () => {
    expect(channelActivity(fixture(), null)).toEqual([
      { memberId: 'a', name: 'Codex', state: 'queued' },
    ]);
    expect(channelActivity(fixture(), 'thread')).toEqual([
      { memberId: 'b', name: 'Amp', state: 'typing' },
    ]);
  });
  it('shows offline members independently from peers and clears completed activity', () => {
    const data = fixture();
    data.jobs[0].blockedReason = 'DEVICE_OFFLINE';
    expect(channelActivity(data, null)[0].state).toBe('offline');
    data.jobs[1].status = 'completed';
    data.runs[0].writerReleased = true;
    expect(channelActivity(data, 'thread')).toEqual([]);
  });
  it('gives approval precedence over a previous output event', () => {
    const data = fixture();
    data.runs[0].status = 'awaiting_approval';
    expect(channelActivity(data, 'thread')[0].state).toBe('awaiting_approval');
  });
  it('keeps a cancelled run visible until physical stop is confirmed', () => {
    const data = fixture();
    data.jobs[1].status = 'cancelled';
    data.runs[0].status = 'stop_requested';
    data.runs[0].writerReleased = false;
    expect(channelActivity(data, 'thread')[0].state).toBe('stop_requested');
    data.runs[0].writerReleased = true;
    expect(channelActivity(data, 'thread')).toEqual([]);
  });
  it('does not show a historic failure over a newer request', () => {
    const data = fixture();
    data.jobs[0].status = 'failed';
    data.jobs[0].messageId = 'old';
    expect(channelActivity(data, null)).toEqual([]);
  });
  it('derives cancellation from durable stop state, not publication revocation', () => {
    const data = fixture();
    data.messages[0].threadId = 'thread';
    data.jobs[1].status = 'cancelled';
    data.runs[0].status = 'failed';
    data.runs[0].publicationRevoked = true;
    data.runs[0].writerReleased = true;
    data.runs[0].physicalStopped = false;
    expect(channelActivity(data, 'thread')[0].state).toBe('stop_requested');
    data.runs[0].physicalStopped = true;
    expect(channelActivity(data, 'thread')).toEqual([]);
  });
  it.each(['failed', 'execution_unknown'] as const)(
    'shows genuine %s execution even when publication is revoked',
    (status) => {
      const data = fixture();
      data.messages[0].threadId = 'thread';
      data.jobs[1].status = 'failed';
      data.runs[0].status = status;
      data.runs[0].publicationRevoked = true;
      data.runs[0].writerReleased = true;
      data.runs[0].physicalStopped = status === 'failed';
      expect(channelActivity(data, 'thread')[0].state).toBe(status);
    },
  );
  it('keeps a heterogeneous cancellation active until physical stop is observed', () => {
    const data = fixture();
    data.messages[0].threadId = 'thread';
    data.jobs[1].status = 'cancelled';
    data.runs[0].status = 'stopped';
    data.runs[0].publicationRevoked = true;
    data.runs[0].writerReleased = true;
    data.runs[0].physicalStopped = false;
    expect(channelActivity(data, 'thread')[0].state).toBe('stop_requested');
  });
  it('shows a durable pause for queued work without hiding a still-stopping thread run', () => {
    const data = fixture();
    data.members[0].executionPaused = true;
    data.members[1].executionPaused = true;
    data.jobs[1].status = 'cancelled';
    data.runs[0].status = 'stop_requested';
    data.runs[0].writerReleased = false;
    expect(channelActivity(data, null)[0].state).toBe('paused');
    expect(channelActivity(data, 'thread')[0].state).toBe('stop_requested');
  });
});
