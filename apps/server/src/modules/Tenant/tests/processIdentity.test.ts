// @vitest-environment node
import type * as NodeFS from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readProcessIdentity, verifyTerminatedProcess } from '../processIdentity';

const state = vi.hoisted(() => ({ empty: false }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof NodeFS>();
  return {
    ...fs,
    readFileSync: (path: any, ...args: any[]) =>
      state.empty && path === '/etc/machine-id' ? '\n' : (fs.readFileSync as any)(path, ...args),
  };
});
afterEach(() => {
  state.empty = false;
});
describe('verified process retirement', () => {
  it('does not infer a reboot from a different boot on a cloned host identity', () => {
    const identity = readProcessIdentity();
    if (!identity.hostId) throw new Error('Linux process identity required');
    expect(identity.hostId).toBeTruthy();
    expect(() =>
      verifyTerminatedProcess({ ...identity, bootId: 'another-machine-boot', pid: process.pid }),
    ).toThrow('RETIRE_BOOT_NOT_VERIFIED');
  });
  it('refuses an empty machine identity', () => {
    state.empty = true;
    expect(readProcessIdentity().hostId).toBeNull();
  });
  it('refuses another PID namespace and the current live process', () => {
    const identity = readProcessIdentity();
    if (!identity.hostId) throw new Error('Linux process identity required');
    expect(() =>
      verifyTerminatedProcess({ ...identity, pidNs: 'another-namespace', pid: process.pid }),
    ).toThrow('RETIRE_PID_NAMESPACE_NOT_VERIFIED');
    expect(() => verifyTerminatedProcess({ ...identity, pid: process.pid })).toThrow(
      'RETIRE_PROCESS_STILL_ALIVE',
    );
  });
});
