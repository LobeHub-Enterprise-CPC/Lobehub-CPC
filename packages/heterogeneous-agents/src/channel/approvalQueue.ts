/** Each native request receives its own visible decision; queued requests cannot share approval. */
export class ChannelApprovalQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  run(task: () => Promise<{ decision: 'accept' | 'decline' }>) {
    const result = this.tail.then(() => (this.closed ? { decision: 'decline' as const } : task()));
    this.tail = result.catch(() => {});
    return result;
  }

  close() {
    this.closed = true;
  }
}
