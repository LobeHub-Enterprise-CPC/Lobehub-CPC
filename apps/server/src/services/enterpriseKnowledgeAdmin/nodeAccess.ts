import type {
  EnterpriseKbGrantInput,
  EnterpriseKbNodeAccessState,
} from '@lobechat/business-knowledge';
import {
  estimateEnterpriseKbNodeAccess,
  getEnterpriseKbNodeAccessState,
  updateEnterpriseKbNodeAccess,
} from '@lobechat/business-knowledge';

import type { LobeChatDatabase } from '@/database/type';

import { breadcrumbFor, findContent, loadContent } from './contentData';
import { notFound } from './errors';
import { type AdminActor, loadEnterpriseKb, toEnterpriseActor } from './shared';

interface NodeAccessInput {
  grants: EnterpriseKbGrantInput[];
  mode: 'custom' | 'inherit';
}

export class EnterpriseKbNodeAccessService {
  constructor(private readonly db: LobeChatDatabase) {}

  get = async (knowledgeBaseId: string, nodeId: string) => {
    const context = await this.load(this.db, knowledgeBaseId, nodeId);
    const state = await getEnterpriseKbNodeAccessState(this.db, {
      ancestorIds: context.ancestorIds,
      knowledgeBaseId,
      nodeId,
    });
    return this.view(context, state);
  };

  update = async (
    knowledgeBaseId: string,
    nodeId: string,
    input: NodeAccessInput & { actor: AdminActor; version: number },
  ) =>
    this.db.transaction(async (tx) => {
      const db = tx as unknown as LobeChatDatabase;
      const context = await this.load(db, knowledgeBaseId, nodeId, true);
      const state = await updateEnterpriseKbNodeAccess(tx, {
        ...input,
        actor: toEnterpriseActor(input.actor),
        ancestorIds: context.ancestorIds,
        knowledgeBaseId,
        nodeId,
        nodeKind: context.node.kind,
        nodeName: context.node.name,
      });
      return this.view(context, state);
    });

  estimate = async (knowledgeBaseId: string, nodeId: string, input: NodeAccessInput) => {
    const context = await this.load(this.db, knowledgeBaseId, nodeId);
    return estimateEnterpriseKbNodeAccess(this.db, {
      ...input,
      ancestorIds: context.ancestorIds,
      knowledgeBaseId,
      nodeId,
    });
  };

  private load = async (
    db: LobeChatDatabase,
    knowledgeBaseId: string,
    nodeId: string,
    lock = false,
  ) => {
    const kb = await loadEnterpriseKb(db, knowledgeBaseId, lock);
    const rows = await loadContent(db, kb);
    const { item } = findContent(rows, nodeId);
    // breadcrumbFor validates library membership, live folders and cycles; the seam needs parent first.
    const ancestors = breadcrumbFor(rows, item.parentId).toReversed();
    return {
      ancestorIds: ancestors.map((node) => node.id),
      ancestors,
      kb,
      node: { id: item.id, kind: item.kind, name: item.name },
    };
  };

  private view = (
    context: Awaited<ReturnType<EnterpriseKbNodeAccessService['load']>>,
    state: EnterpriseKbNodeAccessState,
  ) => {
    const inheritedName = state.inheritedFromNodeId
      ? context.ancestors.find((node) => node.id === state.inheritedFromNodeId)?.name
      : context.kb.name;
    if (inheritedName === undefined) throw notFound('Item');
    return {
      ...state,
      inheritedFrom: { id: state.inheritedFromNodeId, name: inheritedName },
      node: context.node,
    };
  };
}
