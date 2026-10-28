import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { withExecutionSignal } from './executionSignal';

describe('process execution authority', () => {
  it('checks authority at the actual spawn boundary', () => {
    const signal = new AbortController();
    const nativeSpawn = vi.fn();
    const guarded = withExecutionSignal(nativeSpawn as unknown as typeof spawn, signal.signal);
    signal.abort();
    expect(() => guarded(process.execPath, ['-e', 'process.exit(0)'])).toThrow();
    expect(nativeSpawn).not.toHaveBeenCalled();
  });

  it('cancels its own spawned process when authority is revoked', async () => {
    const signal = new AbortController();
    const child = withExecutionSignal(spawn, signal.signal)(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    const closed = once(child, 'close');
    signal.abort();
    const [code, reason] = await closed;
    expect(code === null || code !== 0).toBe(true);
    expect(reason).toBe('SIGKILL');
  });
});
