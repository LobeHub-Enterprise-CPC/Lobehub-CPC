// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildGroupAgentContext } from './groupContext';

const supervisor = { agentId: 'agt_sup', name: null, role: 'supervisor', title: 'Supervisor' };

describe('buildGroupAgentContext', () => {
  it('names a member added from existing agents, which has a name and no title', () => {
    const context = buildGroupAgentContext('agt_sup', { title: 'Team' }, [
      supervisor,
      { agentId: 'agt_plain', name: '小漫', role: 'participant', title: null },
    ]);

    expect(context?.agentMap?.agt_plain.name).toBe('小漫');
    expect(context?.members?.find((member) => member.id === 'agt_plain')?.name).toBe('小漫');
  });

  it('prefers the name over a title, which holds the role of a named agent', () => {
    const context = buildGroupAgentContext('agt_sup', undefined, [
      supervisor,
      { agentId: 'agt_role', name: '小漫', role: 'participant', title: '界面验收测试助手' },
    ]);

    expect(context?.agentMap?.agt_role.name).toBe('小漫');
  });

  it('falls back only when neither field holds text', () => {
    const context = buildGroupAgentContext('agt_sup', undefined, [
      supervisor,
      { agentId: 'agt_blank', name: '  ', role: 'participant', title: null },
    ]);

    expect(context?.agentMap?.agt_blank.name).toBe('Untitled Agent');
  });

  it('marks the responding agent with its resolved name', () => {
    const context = buildGroupAgentContext('agt_plain', undefined, [
      supervisor,
      { agentId: 'agt_plain', name: '小漫', role: 'participant', title: null },
    ]);

    expect(context?.currentAgentName).toBe('小漫');
  });
});
