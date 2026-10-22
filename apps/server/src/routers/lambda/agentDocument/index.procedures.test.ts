// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { agentDocumentRouter } from './index';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('agentDocumentRouter procedures', () => {
  const procedures = (agentDocumentRouter as any)._def.procedures as Record<string, any>;

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
    ['associateDocument', 'mutation', 14],
    ['cloneDocuments', 'mutation', 14],
    ['convertDocumentToSkill', 'mutation', 14],
    ['copyDocument', 'mutation', 14],
    ['copyDocumentByPath', 'mutation', 14],
    ['createDocument', 'mutation', 14],
    ['createFolder', 'mutation', 14],
    ['createForTopic', 'mutation', 14],
    ['createSkillByPath', 'mutation', 14],
    ['deleteAllDocuments', 'mutation', 14],
    ['deleteDocument', 'mutation', 14],
    ['deleteDocumentByPath', 'mutation', 14],
    ['deleteDocumentPermanentlyByPath', 'mutation', 14],
    ['deleteSkillByPath', 'mutation', 14],
    ['generateSkillMeta', 'mutation', 14],
    ['getContext', 'query', 13],
    ['getContextDocuments', 'query', 13],
    ['getDocument', 'query', 13],
    ['getDocuments', 'query', 13],
    ['getDocumentsMap', 'query', 13],
    ['getOrCreateChatTopic', 'mutation', 13],
    ['getReaderDocument', 'query', 13],
    ['getTemplates', 'query', 12],
    ['hasDocuments', 'query', 13],
    ['importFile', 'mutation', 14],
    ['initializeFromTemplate', 'mutation', 14],
    ['listDocuments', 'query', 13],
    ['listDocumentsByPath', 'query', 13],
    ['listTrashDocumentsByPath', 'query', 13],
    ['mkdirDocumentByPath', 'mutation', 14],
    ['modifyNodes', 'mutation', 14],
    ['moveDocuments', 'mutation', 14],
    ['readDocument', 'query', 13],
    ['readDocumentByPath', 'query', 13],
    ['removeDocument', 'mutation', 14],
    ['renameDocument', 'mutation', 14],
    ['renameDocumentByPath', 'mutation', 14],
    ['replaceDocumentContent', 'mutation', 14],
    ['restoreDocumentFromTrashByPath', 'mutation', 14],
    ['statDocumentByPath', 'query', 13],
    ['updateLoadRule', 'mutation', 14],
    ['updateSkillByPath', 'mutation', 14],
    ['upsertDocument', 'mutation', 14],
    ['writeDocumentByPath', 'mutation', 14],
  ];
}
