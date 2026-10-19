import type { spawn } from 'node:child_process';

/** Check at the actual spawn boundary, after asynchronous runtime/policy preparation. */
export function withExecutionSignal(
  spawnProcess: typeof spawn,
  signal?: AbortSignal,
): typeof spawn {
  if (!signal) return spawnProcess;
  return ((...args: Parameters<typeof spawn>) => {
    signal.throwIfAborted();
    const child = spawnProcess(...args);
    const abort = () => {
      const detached = args.some(
        (arg) => typeof arg === 'object' && 'detached' in arg && arg.detached === true,
      );
      try {
        if (child.pid && detached && process.platform !== 'win32')
          process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    child.once('close', () => signal.removeEventListener('abort', abort));
    return child;
  }) as typeof spawn;
}
