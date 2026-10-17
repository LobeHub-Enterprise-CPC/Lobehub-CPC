import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { withExecutionSignal as desktopSpawn } from '../../../desktop/src/main/utils/executionSignal';
import { withExecutionSignal as cliSpawn } from './executionSignal';

describe.each([
  ['CLI', cliSpawn],
  ['desktop', desktopSpawn],
] as const)('%s process execution authority', (_host, withSignal) => {
  it('checks authority at the actual spawn boundary', () => {
    const signal = new AbortController();
    const nativeSpawn = vi.fn();
    const guarded = withSignal(nativeSpawn as unknown as typeof spawn, signal.signal);
    signal.abort();
    expect(() => guarded(process.execPath, ['-e', 'process.exit(0)'])).toThrow();
    expect(nativeSpawn).not.toHaveBeenCalled();
  });

  it('cancels its own spawned process when authority is revoked', async () => {
    const signal = new AbortController();
    const child = withSignal(spawn, signal.signal)(
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
