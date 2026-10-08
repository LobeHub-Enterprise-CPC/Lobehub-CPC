import type { LobeAgentAgencyConfig } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentService } from '@/services/agent';
import { deviceService } from '@/services/device';
import { gatewayConnectionService } from '@/services/electron/gatewayConnection';

import {
  ChannelReadinessError,
  diagnoseChannelCandidate,
  resolveChannelCandidates,
  resolveChannelSelections,
} from './resolveMembers';

const client = vi.hoisted(() => ({
  desktop: true,
  legacy: {} as Record<string, string>,
  storeDeviceId: 'a' as string | undefined,
}));
vi.mock('@lobechat/const', () => ({
  get isDesktop() {
    return client.desktop;
  },
}));
vi.mock('i18next', () => ({ t: (_: string, { name }: { name: string }) => `Not ready: ${name}` }));
vi.mock('@/services/agent', () => ({ agentService: { getAgentConfigById: vi.fn() } }));
vi.mock('@/services/device', () => ({
  deviceService: { listDevices: vi.fn(), updateDevice: vi.fn() },
}));
vi.mock('@/store/agent', () => ({
  getAgentStoreState: () => ({ localAgentWorkingDirectoryMap: client.legacy }),
}));
vi.mock('@/services/electron/gatewayConnection', () => ({
  gatewayConnectionService: { getDeviceInfo: vi.fn() },
}));
vi.mock('@/store/electron', () => ({
  getElectronStoreState: () => ({
    gatewayDeviceInfo: client.storeDeviceId ? { deviceId: client.storeDeviceId } : undefined,
  }),
}));
vi.mock('@/helpers/GlobalAgentContextManager', () => ({
  globalAgentContextManager: {
    getContext: () => ({ homePath: '/home/local', desktopPath: '/home/local/Desktop' }),
  },
}));

const devices = [
  { deviceId: 'a', online: true, defaultCwd: '/alpha', workingDirs: [{ path: '/registered' }] },
  { deviceId: 'b', online: true, defaultCwd: '/beta', workingDirs: [] },
] as Awaited<ReturnType<typeof deviceService.listDevices>>;

function agent(id: string, agencyConfig?: LobeAgentAgencyConfig) {
  // Native Agents come back with the user's default model merged in, as the server does.
  const model = agencyConfig?.heterogeneousProvider ? {} : { model: 'gpt-5', provider: 'openai' };
  return { id, title: id, agencyConfig, ...model } as NonNullable<
    Awaited<ReturnType<typeof agentService.getAgentConfigById>>
  > & { id: string };
}
function hetero(
  type: 'codex' | 'amp' | 'grok-build',
  boundDeviceId: string,
): LobeAgentAgencyConfig {
  return {
    executionTarget: 'device',
    boundDeviceId,
    heterogeneousProvider: { type, command: type },
  };
}

describe('Channel selections preserve existing Agent execution settings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    client.desktop = true;
    client.legacy = {};
    client.storeDeviceId = 'a';
    vi.mocked(deviceService.listDevices).mockResolvedValue(devices);
  });

  it('asks the desktop for its device id when no chat input has loaded it yet', async () => {
    // A freshly created Codex has only a provider — no execution target or binding.
    client.storeDeviceId = undefined;
    vi.mocked(gatewayConnectionService.getDeviceInfo).mockResolvedValue({
      deviceId: 'a',
      hostname: 'mac',
      platform: 'darwin',
    });
    vi.mocked(agentService.getAgentConfigById).mockResolvedValue(
      agent('codex', { heterogeneousProvider: { type: 'codex', command: 'codex' } }),
    );
    expect(await resolveChannelSelections(['codex'])).toEqual([
      { agentId: 'codex', deviceId: 'a', workingDirectory: '/alpha' },
    ]);
    expect(gatewayConnectionService.getDeviceInfo).toHaveBeenCalledOnce();

    vi.mocked(gatewayConnectionService.getDeviceInfo).mockRejectedValue(new Error('no ipc'));
    await expect(resolveChannelSelections(['codex'])).rejects.toThrow('Not ready: codex');

    client.storeDeviceId = 'a';
    vi.mocked(gatewayConnectionService.getDeviceInfo).mockClear();
    await resolveChannelSelections(['codex']);
    expect(gatewayConnectionService.getDeviceInfo).not.toHaveBeenCalled();
  });

  it('resolves Codex, Amp and Grok independently, without lending their device to native Agents', async () => {
    const agents = [
      agent('codex', { ...hetero('codex', 'a'), workingDirByDevice: { a: '/codex', b: '/wrong' } }),
      agent('amp', hetero('amp', 'b')),
      agent('grok', { ...hetero('grok-build', 'a'), workingDirByDevice: { a: '/grok' } }),
      agent('native'),
    ];
    const original = structuredClone(agents);
    vi.mocked(agentService.getAgentConfigById).mockImplementation(async (id) =>
      agents.find((a) => a.id === id)!,
    );
    expect(await resolveChannelSelections(agents.map((a) => a.id))).toEqual([
      { agentId: 'codex', deviceId: 'a', workingDirectory: '/codex' },
      { agentId: 'amp', deviceId: 'b', workingDirectory: '/beta' },
      { agentId: 'grok', deviceId: 'a', workingDirectory: '/grok' },
      { agentId: 'native' },
    ]);
    expect(agents).toEqual(original);
    expect(deviceService.updateDevice).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'a',
      workingDirs: [{ path: '/codex' }, { path: '/grok' }, { path: '/registered' }],
    });
  });

  it.each(['offline', 'missing'] as const)(
    'never reroutes an %s bound Agent to the current online device',
    async (state) => {
      vi.mocked(agentService.getAgentConfigById).mockResolvedValue(
        agent('amp', hetero('amp', 'b')),
      );
      vi.mocked(deviceService.listDevices).mockResolvedValue(
        state === 'missing' ? [devices[0]] : [devices[0], { ...devices[1], online: false }],
      );
      await expect(resolveChannelSelections(['amp'])).rejects.toThrow('Not ready: amp');
      expect(deviceService.updateDevice).not.toHaveBeenCalled();
    },
  );

  it('returns unavailable defaults as an editable candidate without registering anything', async () => {
    vi.mocked(agentService.getAgentConfigById).mockResolvedValue(
      agent('amp', { ...hetero('amp', 'b'), workingDirByDevice: { b: '/channel-draft' } }),
    );
    vi.mocked(deviceService.listDevices).mockResolvedValue([
      devices[0],
      { ...devices[1], online: false },
    ]);
    const result = await resolveChannelCandidates(['amp']);
    expect(result.candidates).toEqual([
      {
        agentId: 'amp',
        deviceId: 'b',
        heterogeneous: true,
        heteroType: 'amp',
        issue: 'offline',
        name: 'amp',
        workingDirectory: '/channel-draft',
      },
    ]);
    expect(deviceService.updateDevice).not.toHaveBeenCalled();
  });

  it('lets the user move a member to another device without touching the Agent binding', async () => {
    const agents = [agent('amp', hetero('amp', 'b')), agent('native')];
    const original = structuredClone(agents);
    vi.mocked(agentService.getAgentConfigById).mockImplementation(async (id) =>
      agents.find((a) => a.id === id)!,
    );
    vi.mocked(deviceService.listDevices).mockResolvedValue([
      devices[0],
      { ...devices[1], online: false },
    ]);
    // Picked device a but no directory yet: still blocked, but for a different reason.
    const partial = await resolveChannelCandidates(['amp', 'native'], {
      amp: { deviceId: 'a', workingDirectory: '' },
      // Native Agents ignore environments entirely.
      native: { deviceId: 'a', workingDirectory: '/ignored' },
    });
    expect(partial.candidates.map((c) => [c.agentId, c.deviceId, c.issue])).toEqual([
      ['amp', 'a', 'noDirectory'],
      ['native', undefined, undefined],
    ]);

    expect(
      await resolveChannelSelections(['amp', 'native'], {
        amp: { deviceId: 'a', workingDirectory: ' /amp-here ' },
      }),
    ).toEqual([
      { agentId: 'amp', deviceId: 'a', workingDirectory: '/amp-here' },
      { agentId: 'native' },
    ]);
    expect(agents).toEqual(original);
    expect(deviceService.updateDevice).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'a',
      workingDirs: [{ path: '/amp-here' }, { path: '/registered' }],
    });
  });

  it('names every blocked Agent in one error instead of the first one found', async () => {
    const agents = [
      agent('amp', hetero('amp', 'b')),
      agent('codex', { ...hetero('codex', 'a'), executionTarget: 'sandbox' }),
      agent('native'),
    ];
    vi.mocked(agentService.getAgentConfigById).mockImplementation(async (id) =>
      agents.find((a) => a.id === id)!,
    );
    vi.mocked(deviceService.listDevices).mockResolvedValue([
      devices[0],
      { ...devices[1], online: false },
    ]);
    const failure = await resolveChannelSelections(['amp', 'codex', 'native']).catch((e) => e);
    expect(failure).toBeInstanceOf(ChannelReadinessError);
    expect(failure.message).toBe('Not ready: amp, codex');
    expect((failure as ChannelReadinessError).candidates.map((c) => [c.agentId, c.issue])).toEqual([
      ['amp', 'offline'],
      ['codex', 'unrouted'],
    ]);
    expect(deviceService.updateDevice).not.toHaveBeenCalled();
  });

  it('applies the server rule that a native Agent needs a model before joining', async () => {
    vi.mocked(agentService.getAgentConfigById).mockResolvedValue({
      ...agent('native'),
      model: '',
    });
    expect((await resolveChannelCandidates(['native'])).candidates[0].issue).toBe('noModel');
    await expect(resolveChannelSelections(['native'])).rejects.toThrow('Not ready: native');
  });

  it('uses the desktop for local Agents and the saved binding on web', async () => {
    vi.mocked(agentService.getAgentConfigById).mockResolvedValue(
      agent('codex', { ...hetero('codex', 'b'), executionTarget: 'local' }),
    );
    expect(await resolveChannelSelections(['codex'])).toEqual([
      { agentId: 'codex', deviceId: 'a', workingDirectory: '/alpha' },
    ]);
    client.desktop = false;
    expect(await resolveChannelSelections(['codex'])).toEqual([
      { agentId: 'codex', deviceId: 'b', workingDirectory: '/beta' },
    ]);
  });

  it('auto selects only a single online device and does not override an explicit sandbox', async () => {
    vi.mocked(agentService.getAgentConfigById).mockResolvedValue(
      agent('codex', { ...hetero('codex', 'a'), executionTarget: 'auto' }),
    );
    await expect(resolveChannelSelections(['codex'])).rejects.toThrow('Not ready');
    vi.mocked(deviceService.listDevices).mockResolvedValue([devices[1]]);
    expect(await resolveChannelSelections(['codex'])).toEqual([
      { agentId: 'codex', deviceId: 'b', workingDirectory: '/beta' },
    ]);
    vi.mocked(agentService.getAgentConfigById).mockResolvedValue(
      agent('codex', { ...hetero('codex', 'b'), executionTarget: 'sandbox' }),
    );
    await expect(resolveChannelSelections(['codex'])).rejects.toThrow('Not ready');
  });

  it('does not fetch devices for native-only selection', async () => {
    vi.mocked(agentService.getAgentConfigById).mockResolvedValue(agent('native'));
    expect(await resolveChannelSelections(['native'])).toEqual([{ agentId: 'native' }]);
    expect(deviceService.listDevices).not.toHaveBeenCalled();
    expect(deviceService.updateDevice).not.toHaveBeenCalled();
  });

  it('does not copy a legacy local path to a remote device default', async () => {
    client.legacy = { codex: '/only-on-this-mac' };
    vi.mocked(agentService.getAgentConfigById).mockResolvedValue(
      agent('codex', hetero('codex', 'b')),
    );
    expect((await resolveChannelCandidates(['codex'])).candidates[0].workingDirectory).toBe(
      '/beta',
    );
    vi.mocked(agentService.getAgentConfigById).mockResolvedValue(
      agent('codex', hetero('codex', 'a')),
    );
    expect((await resolveChannelCandidates(['codex'])).candidates[0].workingDirectory).toBe(
      '/only-on-this-mac',
    );
    expect(deviceService.updateDevice).not.toHaveBeenCalled();
  });

  it('reports an Agent removed after the picker loaded without accessing devices', async () => {
    vi.mocked(agentService.getAgentConfigById).mockResolvedValue(null);
    await expect(resolveChannelSelections(['removed'])).rejects.toThrow('Not ready: removed');
    expect(deviceService.listDevices).not.toHaveBeenCalled();
  });
});

describe('diagnoseChannelCandidate', () => {
  it('reports the first blocker in the order the user can fix them', () => {
    const base = { deviceId: 'a', deviceOnline: true, hasModel: true, workingDirectory: '/w' };
    expect(diagnoseChannelCandidate({ ...base, heteroType: 'codex' })).toBeUndefined();
    expect(diagnoseChannelCandidate({ ...base, heteroType: 'native' })).toBe('unsupported');
    expect(diagnoseChannelCandidate({ ...base, heteroType: 'cursor' })).toBe('unsupported');
    expect(
      diagnoseChannelCandidate({
        ...base,
        heteroType: 'amp',
        deviceId: undefined,
        deviceOnline: false,
      }),
    ).toBe('unrouted');
    expect(diagnoseChannelCandidate({ ...base, heteroType: 'amp', deviceOnline: false })).toBe(
      'offline',
    );
    expect(
      diagnoseChannelCandidate({ ...base, heteroType: 'amp', workingDirectory: undefined }),
    ).toBe('noDirectory');
  });

  it('ignores device state for native Agents and only checks the model', () => {
    const native = { deviceOnline: false, hasModel: true };
    expect(diagnoseChannelCandidate(native)).toBeUndefined();
    expect(diagnoseChannelCandidate({ ...native, hasModel: false })).toBe('noModel');
  });
});
