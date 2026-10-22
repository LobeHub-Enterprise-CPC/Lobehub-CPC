// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { fileRouter } from '.';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('fileRouter procedures', () => {
  const procedures = (fileRouter as any)._def.procedures as Record<string, any>;

  it('exposes exactly the expected procedure paths', () => {
    expect(Object.keys(procedures).sort()).toEqual(expected().map(([name]) => name));
  });

  it.each(expected())('%s is a %s with %i middlewares', (name, type, middlewares) => {
    expect(procedures[name]._def.type).toBe(type);
    expect(procedures[name]._def.middlewares).toHaveLength(middlewares);
  });
});

function expected(): Array<
  [name: string, type: 'mutation' | 'query' | 'subscription', middlewares: number]
> {
  return [
    ['checkFileHash', 'mutation', 15],
    ['copyEntityToWorkspace', 'mutation', 14],
    ['createFile', 'mutation', 14],
    ['deleteKnowledgeItemsByQuery', 'mutation', 14],
    ['findById', 'query', 13],
    ['getFileItemById', 'query', 13],
    ['getFiles', 'query', 13],
    ['getKnowledgeItemStatusesByIds', 'query', 13],
    ['getKnowledgeItems', 'query', 13],
    ['getReadableUrl', 'query', 13],
    ['publishFileToWorkspace', 'mutation', 14],
    ['recentFiles', 'query', 13],
    ['recentPages', 'query', 13],
    ['rehostImage', 'mutation', 15],
    ['removeFile', 'mutation', 14],
    ['removeFileAsyncTask', 'mutation', 14],
    ['removeFiles', 'mutation', 14],
    ['removeUnreferencedFile', 'mutation', 14],
    ['resolveKnowledgeItemIds', 'query', 13],
    ['setFileVisibility', 'mutation', 14],
    ['transferEntity', 'mutation', 14],
    ['updateFile', 'mutation', 14],
  ];
}
