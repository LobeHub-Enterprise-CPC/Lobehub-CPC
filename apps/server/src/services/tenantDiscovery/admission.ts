import { unavailable } from './errors';

interface Waiter {
  cancel: () => void;
  start: () => void;
}
/** A slot remains occupied until actual work settles, including after caller cancellation. */
export class DiscoveryAdmission {
  private active = 0;
  private queue: Waiter[] = [];

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= 4) {
      if (this.queue.length >= 16) throw unavailable();
      await new Promise<void>((resolve, reject) => {
        const remove = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', waiter.cancel);
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
        };
        const waiter: Waiter = {
          cancel: () => {
            remove();
            reject(unavailable());
          },
          start: () => {
            remove();
            this.active += 1;
            resolve();
          },
        };
        const timer = setTimeout(waiter.cancel, 2000);
        this.queue.push(waiter);
        signal.addEventListener('abort', waiter.cancel, { once: true });
        if (signal.aborted) waiter.cancel();
      });
    } else this.active += 1;
    return this.occupy(signal, work);
  }

  /**
   * For optional work that must never compete with user-initiated lookups: takes a free slot
   * now or fails at once, and never joins the queue.
   */
  async tryRun<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= 4) throw unavailable();
    this.active += 1;
    return this.occupy(signal, work);
  }

  private async occupy<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      this.active -= 1;
      this.queue[0]?.start();
    }
  }
}
export const discoveryAdmission = new DiscoveryAdmission();

/** Abort pending operations when the peer disconnects or the total 6s budget expires. */
export const withDiscoveryDeadline = async <T>(
  requestSignal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  requestSignal.addEventListener('abort', abort, { once: true });
  if (requestSignal.aborted) abort();
  const timer = setTimeout(abort, 6000);
  let cancel: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(unavailable());
      controller.signal.addEventListener('abort', cancel, { once: true });
      if (controller.signal.aborted) cancel();
    });
    return await Promise.race([work(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    requestSignal.removeEventListener('abort', abort);
    if (cancel) controller.signal.removeEventListener('abort', cancel);
  }
};
