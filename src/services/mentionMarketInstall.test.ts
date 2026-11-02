import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  ensureAgentMarketSkills: vi.fn(),
  ensureAgentMarketSkillsAndWarn: vi.fn(),
  getAgentByForkedFromIdentifier: vi.fn(),
  getAssistantDetail: vi.fn(),
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  getActiveWorkspaceId: () => 'ws_1',
}));
vi.mock('@/services/agent', () => ({
  agentService: { getAgentByForkedFromIdentifier: mocks.getAgentByForkedFromIdentifier },
}));
vi.mock('@/services/discover', () => ({
  discoverService: { getAssistantDetail: mocks.getAssistantDetail },
}));
vi.mock('@/services/ensureAgentMarketSkills', () => ({
  ensureAgentMarketSkills: mocks.ensureAgentMarketSkills,
  ensureAgentMarketSkillsAndWarn: mocks.ensureAgentMarketSkillsAndWarn,
}));
vi.mock('@/store/agent', () => ({
  useAgentStore: { getState: () => ({ createAgent: mocks.createAgent }) },
}));

const { installMarketMentions } = await import('./mentionMarketInstall');

const detail = {
  avatar: '🎯',
  config: { plugins: ['okr-skill'], systemRole: 'You are an OKR coach' },
  description: 'Writes OKRs',
  title: 'OKR 教练',
};

describe('installMarketMentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAssistantDetail.mockResolvedValue(detail);
    mocks.createAgent.mockResolvedValue({ agentId: 'agt_hidden' });
  });

  it('runs a mentioned Market agent from a hidden copy instead of installing it', async () => {
    mocks.getAgentByForkedFromIdentifier.mockResolvedValue(null);

    const installed = await installMarketMentions({
      agents: [{ identifier: 'okr-coach', label: 'OKR 教练', visibility: 'public' }],
      skills: [],
    });

    expect(installed.get('okr-coach')).toBe('agt_hidden');
    expect(mocks.getAgentByForkedFromIdentifier).toHaveBeenCalledWith('okr-coach', {
      virtual: true,
    });
    const { config, visibility } = mocks.createAgent.mock.calls[0][0];
    expect(config).toMatchObject({
      params: { forkedFromIdentifier: 'okr-coach' },
      systemRole: 'You are an OKR coach',
      title: 'OKR 教练',
      virtual: true,
    });
    expect(config.marketIdentifier).toBeUndefined();
    expect(visibility).toBe('public');
    expect(mocks.ensureAgentMarketSkillsAndWarn).toHaveBeenCalledWith(['okr-skill']);
  });

  it('reuses the hidden copy an earlier mention created', async () => {
    mocks.getAgentByForkedFromIdentifier.mockResolvedValue('agt_earlier');

    const installed = await installMarketMentions({
      agents: [{ identifier: 'reused-coach', label: 'OKR 教练', visibility: 'private' }],
      skills: [],
    });

    expect(installed.get('reused-coach')).toBe('agt_earlier');
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });
});
