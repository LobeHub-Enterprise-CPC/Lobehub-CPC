// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DetailProvider } from './DetailProvider';
import Header from './Header';

vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));
vi.mock('@/hooks/useSkillCategory', () => ({ useSkillCategoryItem: () => undefined }));
vi.mock('@/services/skill', () => ({ agentSkillService: {} }));
vi.mock('@/store/discover', () => ({
  useDiscoverStore: (selector: (state: any) => unknown) =>
    selector({ useFetchSkillComments: () => ({ queryKey: 'comments' }) }),
}));
vi.mock('@/store/discover/selectors', () => ({
  skillSelectors: { skillComments: () => () => undefined },
}));
vi.mock('@/store/tool', () => ({
  useToolStore: (selector: (state: any) => unknown) =>
    selector({
      deleteAgentSkill: vi.fn(),
      refreshAgentSkills: vi.fn(),
      useFetchAgentSkills: () => undefined,
    }),
}));
vi.mock('@/store/tool/selectors', () => ({
  agentSkillsSelectors: {
    getAgentSkillByIdentifier: () => () => undefined,
    isAgentSkill: () => () => false,
  },
}));

const renderHeader = (config: Record<string, unknown>) =>
  render(
    <DetailProvider
      config={{
        author: { name: 'A' },
        createdAt: '2026-01-01',
        identifier: 'skill-1',
        name: 'Skill',
        ...config,
      }}
    >
      <Header />
    </DetailProvider>,
  );

describe('community skill detail Header: platform sync state', () => {
  it('marks a copy that was detached from platform sync', () => {
    renderHeader({ contentSync: { detached: true } });

    expect(screen.getByTestId('content-sync-detached')).toBeInTheDocument();
  });

  it.each([
    ['still synced', { contentSync: { detached: false } }],
    ['no binding', { contentSync: null }],
    ['not reported', {}],
  ])('says nothing for %s', (_name, config) => {
    renderHeader(config);

    expect(screen.queryByTestId('content-sync-detached')).toBeNull();
  });
});
