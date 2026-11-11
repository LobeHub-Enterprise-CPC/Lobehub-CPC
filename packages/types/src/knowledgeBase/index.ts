import type { FilesConfigItem } from '../user/settings/filesConfig';

export enum KnowledgeBaseTabs {
  Files = 'files',
  Settings = 'Settings',
  Testing = 'testing',
}

/** Enterprise knowledge base metadata, present only on knowledge bases shared by a distribution. */
export interface EnterpriseKnowledgeBaseInfo {
  /** What the caller may do with this knowledge base. */
  accessLevel: 'edit' | 'owner' | 'path' | 'view';
  /** Display name of the knowledge base's owner (负责人). */
  ownerName: string;
}

export interface KnowledgeBaseItem {
  /** Mounted enterprise knowledge base the caller can no longer access (id and name only). */
  accessRevoked?: boolean;
  avatar: string | null;

  createdAt: Date;
  description?: string | null;
  enabled?: boolean;
  /** Set only for enterprise knowledge bases the caller can access. */
  enterprise?: EnterpriseKnowledgeBaseInfo;

  id: string;

  isPublic: boolean | null;

  name: string;

  settings: any;
  // different types of knowledge bases need to be distinguished
  type: string | null;
  updatedAt: Date;
  /** Creator's user id — surfaced so the sidebar can gate creator-only actions. */
  userId?: string;
  /** Workspace-scoped visibility: `public` (default) or `private` (creator-only). */
  visibility?: 'private' | 'public';
}

export interface CreateKnowledgeBaseParams {
  avatar?: string;
  description?: string;
  name: string;
  /** Workspace-scoped visibility for a newly created KB. Derived from the current resource-mode. */
  visibility?: 'private' | 'public';
}

export enum KnowledgeType {
  File = 'file',
  KnowledgeBase = 'knowledgeBase',
}

export interface KnowledgeItem {
  /**
   * KB only: an enterprise knowledge base mounted on the agent that the caller
   * can no longer access. Only the id and name are kept; it takes no part in retrieval.
   */
  accessRevoked?: boolean;
  avatar?: string | null;
  content?: string;
  description?: string | null;
  enabled?: boolean;
  /** KB only: set for enterprise knowledge bases the caller can access. */
  enterprise?: EnterpriseKnowledgeBaseInfo;
  fileType?: string;
  id: string;
  /**
   * KB only: carries a `use`-level (No-access) resource-permission row, so
   * plain members cannot see or open it. The picker badges the icon with a
   * lock for managers.
   */
  memberRestricted?: boolean;
  name: string;
  /** Creator's user id — used by the picker to gate creator-only actions and identify ownership. */
  ownerUserId?: string;
  type: KnowledgeType;
  /** Workspace-scoped visibility of the underlying resource (file or KB). */
  visibility?: 'private' | 'public';
}

export interface SystemEmbeddingConfig {
  embeddingModel: FilesConfigItem;
  queryMode: string;
  rerankerModel: FilesConfigItem;
}
