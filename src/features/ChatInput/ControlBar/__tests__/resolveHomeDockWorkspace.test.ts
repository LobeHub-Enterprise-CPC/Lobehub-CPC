import { describe, expect, it } from 'vitest';

import { resolveHomeDockWorkspace } from '../resolveHomeDockWorkspace';

describe('resolveHomeDockWorkspace', () => {
  const base = {
    canConfigureResource: true,
    isAccessLoading: false,
    isAgentConfigLoading: false,
    isAgentRuntimeMode: true,
    isHeterogeneous: false,
    isPreferenceLoading: false,
  };

  it('keeps a normal agent hidden until it is in agent runtime mode', () => {
    expect(resolveHomeDockWorkspace({ ...base, isAgentRuntimeMode: false })).toBe('hidden');
    expect(resolveHomeDockWorkspace(base)).toBe('workspace');
  });

  it('always shows a heterogeneous workspace, or only the device when the member cannot edit', () => {
    expect(resolveHomeDockWorkspace({ ...base, isHeterogeneous: true })).toBe('workspace');
    expect(
      resolveHomeDockWorkspace({
        ...base,
        canConfigureResource: false,
        isHeterogeneous: true,
      }),
    ).toBe('device-only');
  });

  it('waits out config, access, and mode-preference loads', () => {
    expect(resolveHomeDockWorkspace({ ...base, isAgentConfigLoading: true })).toBe('pending');
    expect(resolveHomeDockWorkspace({ ...base, isAccessLoading: true })).toBe('pending');
    expect(resolveHomeDockWorkspace({ ...base, isPreferenceLoading: true })).toBe('pending');
    expect(
      resolveHomeDockWorkspace({
        ...base,
        isHeterogeneous: true,
        isPreferenceLoading: true,
      }),
    ).toBe('workspace');
  });
});
