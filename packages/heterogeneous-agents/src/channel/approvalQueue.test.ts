import { describe, expect, it, vi } from 'vitest';

import { ChannelApprovalQueue } from './approvalQueue';

describe('Channel native approvals', () => {
  it('does not replace a pending approval with a concurrent request', async () => {
    const queue = new ChannelApprovalQueue();
    let decide!: (value: { decision: 'accept' }) => void;
    const first = queue.run(
      () =>
        new Promise((resolve) => {
          decide = resolve;
        }),
    );
    const next = vi.fn(async () => ({ decision: 'decline' as const }));
    const second = queue.run(next);
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    decide({ decision: 'accept' });
    expect(await first).toEqual({ decision: 'accept' });
    expect(await second).toEqual({ decision: 'decline' });
    expect(next).toHaveBeenCalledTimes(1);
  });
  it('declines queued requests when execution closes', async () => {
    const queue = new ChannelApprovalQueue();
    const task = vi.fn(async () => ({ decision: 'accept' as const }));
    const pending = queue.run(task);
    queue.close();
    expect(await pending).toEqual({ decision: 'decline' });
    expect(task).not.toHaveBeenCalled();
  });
});
