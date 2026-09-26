import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BuiltinAgentSkillDetailProvider } from './BuiltinAgentSkillDetailProvider';
import { BuiltinDetailProvider } from './BuiltinDetailProvider';
import { useDetailContext } from './DetailContext';

vi.mock('@lobechat/business-const', async (original) => ({
  ...(await original<object>()),
  BRANDING_NAME: 'Private Workspace',
}));
vi.mock('@/store/tool', () => ({
  useToolStore: (selector: any) =>
    selector({
      builtinSkills: [{ identifier: 'test', name: 'Test', description: 'Test skill' }],
      builtinTools: [{ identifier: 'test', manifest: { api: [], meta: { title: 'Test' } } }],
    }),
}));
vi.mock('@/store/tool/selectors', () => ({
  builtinToolSelectors: { allMetaList: () => [{ identifier: 'test', meta: { title: 'Test' } }] },
}));
vi.mock('swr', () => ({ default: () => ({ data: '# Skill' }) }));

const Details = () => {
  const { author, authorUrl } = useDetailContext();
  return (
    <div>
      {author}
      {authorUrl && <a href={authorUrl}>Author</a>}
    </div>
  );
};
afterEach(cleanup);
describe('private builtin details', () => {
  it.each([BuiltinAgentSkillDetailProvider, BuiltinDetailProvider])(
    'brands builtins without linking to the upstream author',
    (Provider) => {
      render(
        <Provider identifier="test">
          <Details />
        </Provider>,
      );
      expect(screen.getByText('Private Workspace')).toBeTruthy();
      expect(screen.queryByRole('link')).toBeNull();
    },
  );
});
