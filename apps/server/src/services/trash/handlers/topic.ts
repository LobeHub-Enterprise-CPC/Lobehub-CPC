import { businessFileExternalReferenceGuard } from '@/business/server/lambda-routers/file';
import { serverDBEnv } from '@/config/db';
import { FileModel } from '@/database/models/file';
import { TopicModel } from '@/database/models/topic';
import type { TrashRegisterEntry } from '@/database/models/trash';
import type { TopicItem } from '@/database/schemas';

import {
  type TrashCascade,
  type TrashHandler,
  type TrashHandlerContext,
  TrashRestoreError,
} from './types';

export const topicEntry = (topic: TopicItem, removeFiles?: boolean): TrashRegisterEntry => ({
  meta: removeFiles ? { removeFiles: true } : undefined,
  resourceId: topic.id,
  resourceType: 'topic',
  title: topic.title,
});

/**
 * Every stamped topic becomes its own root (a bulk "clear topics" is N
 * restorable rows, the same way a multi-select delete in a file manager is).
 * Messages / threads under it are hidden by the parent and hard-cascade at
 * purge time.
 */
export const topicCascades = (topics: TopicItem[], removeFiles?: boolean): TrashCascade[] =>
  topics.map((topic) => ({ children: [], root: topicEntry(topic, removeFiles) }));

export const topicHandler: TrashHandler = {
  purge: async (ctx, root) => {
    // `removeFiles` was requested at delete time: collect the attachments only
    // this topic still references (same reference-safe set the hard delete
    // used). Computed now, not at trash time, so a file that got attached
    // elsewhere meanwhile is kept — and before the delete, because the lookup
    // joins the messages the delete cascades away.
    const fileModel = new FileModel(ctx.db, ctx.userId, ctx.workspaceId);
    const fileIds = root.meta?.removeFiles
      ? await fileModel.findDeletableFilesByTopicId(root.resourceId)
      : [];

    const purged = await new TopicModel(ctx.db, ctx.userId, ctx.workspaceId).purge([
      root.resourceId,
    ]);
    // Nothing deleted means the topic was restored in the meantime: leave its
    // attachments alone too.
    if (purged.length === 0 || fileIds.length === 0) return;

    // The topic purge removed its message links. Re-check every candidate while
    // holding its file-row lock so Channel sends and cleanup cannot pass one another.
    // Sorting gives concurrent purges a stable lock order.
    const removed = [];
    for (const fileId of [...fileIds].sort()) {
      const file = await fileModel.deleteUnreferenced(
        fileId,
        { removeGlobalFile: serverDBEnv.REMOVE_GLOBAL_FILE },
        businessFileExternalReferenceGuard,
      );
      if (file) removed.push(file);
    }

    // deleteUnreferenced returns a row only when its underlying object is no
    // longer shared. Channel references return undefined and remain untouched.
    if (removed.length > 0) {
      await ctx.fileService.deleteFiles(removed.map((file) => file.url!));
    }
  },
  restore: async (ctx: TrashHandlerContext, root) => {
    const topicModel = new TopicModel(ctx.db, ctx.userId, ctx.workspaceId);
    const [topic] = await topicModel.findTrashedByIds([root.resourceId]);
    if (!topic) throw new TrashRestoreError('notFound');

    // No parent-in-bin check yet: a topic's containers (agent, chat group) are
    // not trashable in this phase, so they can never be sitting in the bin.
    // The check goes in with the agent handler — see `TrashRestoreError`'s
    // `parentTrashed` code, which the client already renders.
    await topicModel.restore([root.resourceId]);
  },
  type: 'topic',
};
