import { AgentDocumentsApiName } from '@lobechat/builtin-tool-agent-documents';
import { initializeTenant, setRemoteAppAddress } from '@lobechat/business-tenant/client';
import type { ToolAfterCallContext } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invalidateSpy, getDocumentStoreStateSpy } = vi.hoisted(() => ({
  getDocumentStoreStateSpy: vi.fn(),
  invalidateSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/document/invalidation', () => ({
  invalidateDocumentMutation: invalidateSpy,
}));
vi.mock('@/store/document', () => ({
  getDocumentStoreState: getDocumentStoreStateSpy,
}));
vi.mock('@/services/agentDocument', () => ({ agentDocumentService: {} }));
vi.mock('@/services/work', () => ({ workService: {} }));
vi.mock('@/store/agent', () => ({
  useAgentStore: { getState: () => ({ activeAgentId: 'agent-1' }) },
}));
vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  getActiveWorkspaceSlug: () => mockWorkspaceSlug.current,
}));

const mockWorkspaceSlug = vi.hoisted(() => ({ current: undefined as string | undefined }));

const afterCall = (apiName: string, documentId: string): ToolAfterCallContext =>
  ({
    apiName,
    identifier: 'lobe-agent-documents',
    params: {},
    result: { state: { documentId }, success: true },
    toolCallId: 'call_1',
  }) as ToolAfterCallContext;

describe('agentDocumentsExecutor host invalidation', () => {
  beforeEach(() => {
    invalidateSpy.mockClear();
    getDocumentStoreStateSpy.mockClear();
  });

  it('revalidates the editor key after a content write instead of touching the document store', async () => {
    const { agentDocumentsExecutor } = await import('./lobe-agent-documents');

    await agentDocumentsExecutor.onAfterCall!(
      afterCall(AgentDocumentsApiName.replaceDocumentContent, 'doc-1'),
    );

    expect(invalidateSpy).toHaveBeenCalledWith({
      agentId: 'agent-1',
      cause: 'agent-document',
      documentId: 'doc-1',
    });
    expect(getDocumentStoreStateSpy).not.toHaveBeenCalled();
  });

  it('does not revalidate the editor key of a removed document', async () => {
    const { agentDocumentsExecutor } = await import('./lobe-agent-documents');

    await agentDocumentsExecutor.onAfterCall!(
      afterCall(AgentDocumentsApiName.removeDocument, 'doc-1'),
    );

    expect(invalidateSpy).toHaveBeenCalledWith({
      agentId: 'agent-1',
      cause: 'agent-document',
      documentId: undefined,
    });
  });
});

describe('buildDocumentShareUrl', () => {
  afterEach(() => {
    setRemoteAppAddress(undefined);
    initializeTenant(new URL(window.location.href));
    mockWorkspaceSlug.current = undefined;
  });

  it('keeps the tenant path in the link a web tenant page shares', async () => {
    initializeTenant(new URL(`${window.location.origin}/orgs/acme/agent`));
    const { buildDocumentShareUrl } = await import('./lobe-agent-documents');

    expect(buildDocumentShareUrl('agt_1', 'docs_1')).toBe(
      `${window.location.origin}/orgs/acme/agent/agt_1/docs/1`,
    );
  });

  it('puts the workspace slug after the tenant path', async () => {
    initializeTenant(new URL(`${window.location.origin}/orgs/acme/agent`));
    mockWorkspaceSlug.current = 'team';
    const { buildDocumentShareUrl } = await import('./lobe-agent-documents');

    expect(buildDocumentShareUrl('agt_1', 'docs_1')).toBe(
      `${window.location.origin}/orgs/acme/team/agent/agt_1/docs/1`,
    );
  });

  it('uses the remote tenant address in the desktop renderer', async () => {
    setRemoteAppAddress('https://host.example/orgs/acme');
    const { buildDocumentShareUrl } = await import('./lobe-agent-documents');

    expect(buildDocumentShareUrl('agt_1', 'docs_1')).toBe(
      'https://host.example/orgs/acme/agent/agt_1/docs/1',
    );
  });

  it('has no link before the desktop remote address is configured', async () => {
    setRemoteAppAddress('');
    const { buildDocumentShareUrl } = await import('./lobe-agent-documents');

    expect(buildDocumentShareUrl('agt_1', 'docs_1')).toBeUndefined();
  });
});
