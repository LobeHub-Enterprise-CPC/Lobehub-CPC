import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import CreateForm from './CreateForm';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/features/ResourceManager/store', () => ({
  useResourceManagerStore: (selector: (state: object) => unknown) =>
    selector({ listVisibility: 'workspace' }),
}));
vi.mock('@/store/library', () => ({
  useKnowledgeBaseStore: (selector: (state: object) => unknown) =>
    selector({ createNewKnowledgeBase: vi.fn(), updateKnowledgeBase: vi.fn() }),
}));
vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  useActiveWorkspaceSlug: () => undefined,
}));
vi.mock('@lobechat/business-tenant/client', () => ({
  withCurrentTenantPath: (path: string) => path,
}));

describe('CreateForm', () => {
  const submit = () => screen.getByRole('button', { name: 'createNew.confirm' });
  const nameInput = () => screen.getByRole('textbox', { name: 'createNew.name.placeholder' });

  it('cannot be submitted without a name, so the empty case is not a silent no-op', () => {
    render(<CreateForm />);

    expect(submit()).toBeDisabled();
    expect(nameInput()).toBeRequired();
  });

  it('treats a name of spaces as empty', () => {
    render(<CreateForm />);

    fireEvent.change(nameInput(), { target: { value: '   ' } });

    expect(submit()).toBeDisabled();
  });

  it('enables submit once the name has text', () => {
    render(<CreateForm />);

    fireEvent.change(nameInput(), { target: { value: '资源库' } });

    expect(submit()).toBeEnabled();
  });
});
