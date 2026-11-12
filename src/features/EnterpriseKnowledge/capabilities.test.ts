import { describe, expect, it } from 'vitest';

import { getKnowledgeBaseCapabilities } from './capabilities';

describe('enterprise knowledge base capabilities', () => {
  it('keeps personal/workspace role behavior', () => {
    expect(getKnowledgeBaseCapabilities(undefined, false).canEditContent).toBe(false);
    expect(getKnowledgeBaseCapabilities(undefined).canRemoveLibrary).toBe(true);
  });

  it('view grants never expose writes even with a permissive workspace role', () => {
    const access = getKnowledgeBaseCapabilities({
      enterprise: { accessLevel: 'view', ownerName: 'Owner' },
    });
    expect(access.canEditContent).toBe(false);
    expect(access.canManageInfo).toBe(false);
    expect(access.canManageAccess).toBe(false);
  });

  it('edit grants allow content but not ownership or policy changes', () => {
    const access = getKnowledgeBaseCapabilities(
      { enterprise: { accessLevel: 'edit', ownerName: 'Owner' } },
      false,
    );
    expect(access.canEditContent).toBe(true);
    expect(access.canManageAccess).toBe(false);
    expect(access.canManageInfo).toBe(false);
    expect(access.canTransfer).toBe(false);
    expect(access.canRemoveLibrary).toBe(false);
  });

  it('owners can manage info/access but cannot transfer or delete the library', () => {
    const access = getKnowledgeBaseCapabilities({
      enterprise: { accessLevel: 'owner', ownerName: 'Owner' },
    });
    expect(access.canManageAccess).toBe(true);
    expect(access.canManageInfo).toBe(true);
    expect(access.canTransfer).toBe(false);
    expect(access.canRemoveLibrary).toBe(false);
  });

  it('a revoked mount cannot regain writes through stale enterprise metadata', () => {
    const access = getKnowledgeBaseCapabilities({
      accessRevoked: true,
      enterprise: { accessLevel: 'owner', ownerName: 'Owner' },
    });
    expect(access.canEditContent).toBe(false);
    expect(access.canManageAccess).toBe(false);
  });
});

describe('node capabilities', () => {
  const library = { enterprise: { accessLevel: 'edit' as const, ownerName: 'Owner' } };
  it('fails closed before a directory level resolves', () => {
    expect(getKnowledgeBaseCapabilities(library, true, null).canEditContent).toBe(false);
  });
  it('uses the node level rather than the library level', () => {
    expect(getKnowledgeBaseCapabilities(library, true, 'path').canEditContent).toBe(false);
    expect(getKnowledgeBaseCapabilities(library, true, 'view').canEditContent).toBe(false);
    expect(
      getKnowledgeBaseCapabilities(
        { enterprise: { accessLevel: 'path', ownerName: 'Owner' } },
        false,
        'edit',
      ).canEditContent,
    ).toBe(true);
  });
  it('node grants do not grant library ownership', () => {
    const access = getKnowledgeBaseCapabilities(library, true, 'edit');
    expect(access.canManageAccess).toBe(false);
    expect(access.canManageInfo).toBe(false);
  });
  it('revocation overrides a previously resolved node grant', () => {
    expect(
      getKnowledgeBaseCapabilities({ ...library, accessRevoked: true }, true, 'edit')
        .canEditContent,
    ).toBe(false);
  });
});
