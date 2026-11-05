/**
 * Deliveries this process serves itself (the memory worker), including any whose attempt
 * already timed out: shutdown waits for them as the web server waits for a request it is
 * still answering.
 */
const running = new Set<Promise<unknown>>();

export const trackInProcessWork = <T>(work: Promise<T>): Promise<T> => {
  running.add(work);
  const forget = () => running.delete(work);
  work.then(forget, forget);
  return work;
};

export const inProcessWorkCount = (): number => running.size;

export const settleInProcessWork = async (): Promise<void> => {
  while (running.size > 0) await Promise.allSettled(running);
};
