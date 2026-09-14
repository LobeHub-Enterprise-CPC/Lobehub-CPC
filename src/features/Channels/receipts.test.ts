import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ReceiptStatus } from './MessageReceipts';
import {
  buildChannelReceipts,
  type ChannelDetail,
  isQuietReceipt,
  memberCurrentReceipt,
} from './receipts';

const fixture = () =>
  ({
    contextMessages: [],
    members: [
      {
        id: 'amp',
        name: 'Amp',
        active: true,
        executionPaused: false,
        config: { workingDirectory: '/current' },
      },
      { id: 'grok', name: 'Grok', active: true, executionPaused: false, config: {} },
      { id: 'new', name: 'New member', active: true, config: {} },
    ],
    messages: [
      { id: 'request', sequence: 1, threadId: null, authorMemberId: null, content: '@Amp hello' },
      {
        id: 'thread-request',
        sequence: 3,
        threadId: 'thread',
        authorMemberId: null,
        content: 'Hello',
      },
    ],
    jobs: [
      {
        id: 'job',
        messageId: 'request',
        memberId: 'amp',
        threadId: null,
        status: 'completed',
        createdAt: '2026-09-13T00:00:00Z',
      },
    ],
    runs: [
      {
        jobId: 'job',
        status: 'completed',
        acceptance: 'accepted',
        writerReleased: true,
        physicalStopped: true,
        publicationStatus: 'published',
        publishedMessageId: 'reply',
        executionConfig: { workingDirectory: '/original' },
      },
    ],
  }) as unknown as ChannelDetail;

const receipt = (data: ChannelDetail) => buildChannelReceipts(data).byMessage.get('request')![0];

afterEach(cleanup);

describe('Channel request receipts', () => {
  it('keeps actual historical recipients after roster and thread follower changes', () => {
    const data = fixture();
    data.members[0].active = false;
    data.jobs.push({
      ...data.jobs[0],
      id: 'thread-job',
      messageId: 'thread-request',
      threadId: 'thread',
    });
    const result = buildChannelReceipts(data);
    expect(result.byMessage.get('request')?.map((item) => item.member.id)).toEqual(['amp']);
    expect(result.byMessage.get('thread-request')?.map((item) => item.member.id)).toEqual(['amp']);
    expect(result.byMember.has('new')).toBe(false);
    expect(receipt(data).environment?.workingDirectory).toBe('/original');
  });

  it('does not create receipts for saved requests with no assigned jobs or mismatched scope', () => {
    const data = fixture();
    data.jobs.push({ ...data.jobs[0], id: 'wrong-scope', messageId: 'thread-request' });
    expect(buildChannelReceipts(data).byMessage.has('thread-request')).toBe(false);
    data.jobs = [];
    expect(buildChannelReceipts(data).byMessage.size).toBe(0);
  });

  it('does not infer acceptance or historical environment from a queued job', () => {
    const data = fixture();
    data.jobs[0].status = 'queued';
    data.runs = [];
    expect(receipt(data)).toMatchObject({
      accepted: false,
      environment: null,
      pending: true,
      state: 'queued',
    });
    data.jobs[0].status = 'running';
    expect(receipt(data).state).toBe('starting');
  });

  it('distinguishes blocked delivery, member pause and active execution', () => {
    const data = fixture();
    data.jobs[0].status = 'queued';
    data.jobs[0].blockedReason = 'DEVICE_OFFLINE';
    data.runs = [];
    expect(receipt(data).state).toBe('offline');
    data.jobs[0].blockedReason = 'INVALID_ENVIRONMENT';
    expect(receipt(data).state).toBe('unavailable');
    data.members[0].executionPaused = true;
    expect(receipt(data).state).toBe('paused');
  });

  it('shows approval even after output activity, and failure even after an earlier reply', () => {
    const data = fixture();
    data.jobs[0].status = 'running';
    data.runs[0].writerReleased = false;
    data.runs[0].status = 'running';
    data.runs[0].activity = 'typing';
    expect(receipt(data).state).toBe('typing');
    data.runs[0].status = 'awaiting_approval';
    expect(receipt(data).state).toBe('awaiting_approval');
    data.runs[0].status = 'failed';
    expect(receipt(data)).toMatchObject({ hasReply: true, state: 'failed' });
    expect(isQuietReceipt(receipt(data))).toBe(false);
  });

  it('requires an explicit yield before saying the Agent had nothing to add', () => {
    const data = fixture();
    data.runs[0].publishedMessageId = null;
    data.runs[0].publicationStatus = 'yielded';
    expect(receipt(data).state).toBe('yielded');
    expect(isQuietReceipt(receipt(data))).toBe(true);
    data.runs[0].publicationStatus = 'held';
    expect(receipt(data).state).toBe('held');
    // A historical payload without publication outcome must not claim a reply or silence.
    delete (data.runs[0] as Partial<ChannelDetail['runs'][number]>).publicationStatus;
    expect(receipt(data).state).toBe('completed');
  });

  it('keeps publication pending visible after execution ends', () => {
    const data = fixture();
    data.runs[0].publishedMessageId = null;
    data.runs[0].publicationStatus = 'pending';
    expect(receipt(data)).toMatchObject({ pending: true, state: 'publishing' });
    expect(memberCurrentReceipt([receipt(data)])?.state).toBe('publishing');
  });

  it('aggregates discussion rounds while preserving a published contribution', () => {
    const data = fixture();
    data.jobs.unshift({
      ...data.jobs[0],
      id: 'revision',
      createdAt: new Date('2026-09-13T00:01:00Z'),
    });
    data.runs.push({
      ...data.runs[0],
      jobId: 'revision',
      publishedMessageId: null,
      publicationStatus: 'yielded',
    });
    expect(receipt(data)).toMatchObject({ hasReply: true, pending: false, state: 'replied' });
    data.jobs[0].status = 'queued';
    data.runs.pop();
    expect(receipt(data)).toMatchObject({ hasReply: true, pending: true, state: 'queued' });
  });

  it('keeps an unreleased execution ahead of a later queued discussion round', () => {
    const data = fixture();
    data.jobs.push({
      ...data.jobs[0],
      id: 'revision',
      status: 'queued',
      createdAt: new Date('2026-09-13T00:01:00Z'),
    });
    data.runs[0].writerReleased = false;
    data.runs[0].status = 'awaiting_approval';
    expect(receipt(data).state).toBe('awaiting_approval');
  });

  it('does not claim cancellation finished before both stop confirmations', () => {
    const data = fixture();
    data.jobs[0].status = 'cancelled';
    data.runs[0].publicationRevoked = true;
    data.runs[0].writerReleased = true;
    data.runs[0].physicalStopped = false;
    expect(receipt(data)).toMatchObject({ pending: true, state: 'stop_requested' });
    data.runs[0].physicalStopped = true;
    expect(receipt(data)).toMatchObject({ pending: false, state: 'cancelled' });
  });

  it.each(['failed', 'execution_unknown'] as const)(
    'does not turn a revoked genuine %s execution into cancellation',
    (status) => {
      const data = fixture();
      data.jobs[0].status = 'failed';
      data.runs[0].status = status;
      data.runs[0].publicationRevoked = true;
      data.runs[0].writerReleased = true;
      data.runs[0].physicalStopped = status === 'failed';
      expect(receipt(data)).toMatchObject({
        pending: status === 'execution_unknown',
        state: status,
      });
      render(createElement(ReceiptStatus, { state: receipt(data).state }));
      expect(screen.getByText(`receipt.state.${status}`)).toHaveAttribute('data-tone', 'error');
      expect(screen.queryByText('receipt.state.cancelled')).not.toBeInTheDocument();
    },
  );

  it('keeps cancellation after runtime failure and waits for heterogeneous physical stop', () => {
    const data = fixture();
    data.jobs[0].status = 'cancelled';
    data.runs[0].status = 'failed';
    data.runs[0].publicationRevoked = true;
    data.runs[0].writerReleased = true;
    data.runs[0].physicalStopped = false;
    expect(receipt(data)).toMatchObject({ pending: true, state: 'stop_requested' });
    data.runs[0].physicalStopped = true;
    expect(receipt(data)).toMatchObject({ pending: false, state: 'cancelled' });
    render(createElement(ReceiptStatus, { state: receipt(data).state }));
    expect(screen.getByText('receipt.state.cancelled')).toHaveAttribute('data-tone', 'quiet');
    expect(screen.queryByText('receipt.state.failed')).not.toBeInTheDocument();
  });

  it('retains unknown execution as active without treating it as a successful reply', () => {
    const data = fixture();
    data.runs[0].status = 'execution_unknown';
    expect(receipt(data)).toMatchObject({ pending: true, state: 'execution_unknown' });
  });

  it('shows active work across threads ahead of a newer queued request, and ignores history', () => {
    const data = fixture();
    data.jobs.push({
      ...data.jobs[0],
      id: 'thread-job',
      messageId: 'thread-request',
      threadId: 'thread',
      status: 'queued',
    });
    data.runs[0].status = 'running';
    data.runs[0].writerReleased = false;
    expect(memberCurrentReceipt(buildChannelReceipts(data).byMember.get('amp')!)?.request.id).toBe(
      'request',
    );
    data.runs[0].status = 'failed';
    data.runs[0].writerReleased = true;
    expect(memberCurrentReceipt(buildChannelReceipts(data).byMember.get('amp')!)?.request.id).toBe(
      'thread-request',
    );
    data.jobs.pop();
    expect(memberCurrentReceipt(buildChannelReceipts(data).byMember.get('amp')!)).toBeUndefined();
  });
});
