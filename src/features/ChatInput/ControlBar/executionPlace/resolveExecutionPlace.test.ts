import { describe, expect, it } from 'vitest';

import { resolveExecutionPlace } from './resolveExecutionPlace';

describe('resolveExecutionPlace', () => {
  it('maps local, including a fenced local run, to the computer place', () => {
    expect(resolveExecutionPlace({ target: 'local' })).toBe('local');
    expect(resolveExecutionPlace({ localSandboxEnabled: true, target: 'local' })).toBe('local');
  });

  it('maps a bound device to remote', () => {
    expect(resolveExecutionPlace({ target: 'device' })).toBe('remote');
  });

  it('maps sandbox, none, and auto to cloud without rewriting them', () => {
    expect(resolveExecutionPlace({ target: 'sandbox' })).toBe('cloud');
    expect(resolveExecutionPlace({ target: 'none' })).toBe('cloud');
    expect(resolveExecutionPlace({ target: 'auto' })).toBe('cloud');
    expect(resolveExecutionPlace({ target: undefined })).toBe('cloud');
  });
});
