import type { LobeChatDatabase } from '@lobechat/database';
import {
  chunks,
  documents,
  fileChunks,
  files,
  knowledgeBaseFiles,
  knowledgeBases,
  users,
} from '@lobechat/database/schemas';

import { enterpriseKbState } from '@/server/test-utils/enterpriseKnowledgeFake';

export const context = (userId: string) => ({ jwtPayload: { userId }, userId });

export interface EnterpriseWorld {
  editor: string;
  /** Enterprise knowledge base of `owner`; `viewer` holds view, `editor` holds edit. */
  entA: string;
  entADoc: string;
  entAFile: string;
  entAFolder: string;
  /** A second enterprise knowledge base of `owner` that nobody else can see. */
  entB: string;
  entBFile: string;
  owner: string;
  /** The owner's personal knowledge base and file. */
  personalFile: string;
  personalKb: string;
  stranger: string;
  viewer: string;
}

let counter = 0;
const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${counter++}`;

export const createUser = async (db: LobeChatDatabase, id: string, fullName?: string) => {
  await db.insert(users).values({ fullName: fullName ?? id, id });
  return id;
};

const createKb = async (db: LobeChatDatabase, userId: string, name: string) => {
  const [row] = await db.insert(knowledgeBases).values({ name, userId }).returning();
  return row.id;
};

export const createKbFile = async (
  db: LobeChatDatabase,
  params: { knowledgeBaseId?: string; name: string; parentId?: string; userId: string },
) => {
  const [file] = await db
    .insert(files)
    .values({
      fileType: 'text/plain',
      name: params.name,
      parentId: params.parentId,
      size: 10,
      url: `files/${params.name}`,
      userId: params.userId,
    })
    .returning();
  if (params.knowledgeBaseId) {
    await db
      .insert(knowledgeBaseFiles)
      .values({ fileId: file.id, knowledgeBaseId: params.knowledgeBaseId, userId: params.userId });
  }
  return file.id;
};

export const createChunk = async (
  db: LobeChatDatabase,
  userId: string,
  fileId: string,
  text: string,
) => {
  const [chunk] = await db
    .insert(chunks)
    .values({ index: 0, text, type: 'text', userId })
    .returning();
  await db.insert(fileChunks).values({ chunkId: chunk.id, fileId, userId });
  return chunk.id;
};

export const createDoc = async (
  db: LobeChatDatabase,
  params: {
    content?: string;
    fileType?: string;
    knowledgeBaseId?: string;
    parentId?: string;
    title: string;
    userId: string;
  },
) => {
  const [doc] = await db
    .insert(documents)
    .values({
      content: params.content ?? '',
      fileType: params.fileType ?? 'custom/document',
      filename: params.title,
      knowledgeBaseId: params.knowledgeBaseId,
      parentId: params.parentId,
      source: `doc-${params.title}-${uid('s')}`,
      sourceType: 'api',
      title: params.title,
      totalCharCount: 0,
      totalLineCount: 0,
      userId: params.userId,
    })
    .returning();
  return doc.id;
};

/** Seeds the database and the fake policy store. */
export const seedEnterpriseWorld = async (db: LobeChatDatabase): Promise<EnterpriseWorld> => {
  const owner = await createUser(db, uid('owner'), 'Olivia Owner');
  const viewer = await createUser(db, uid('viewer'));
  const editor = await createUser(db, uid('editor'));
  const stranger = await createUser(db, uid('stranger'));

  const entA = await createKb(db, owner, 'Enterprise A');
  const entB = await createKb(db, owner, 'Enterprise B');
  const personalKb = await createKb(db, owner, 'Owner personal');

  const entAFolder = await createDoc(db, {
    fileType: 'custom/folder',
    knowledgeBaseId: entA,
    title: 'Folder A',
    userId: owner,
  });
  const entAFile = await createKbFile(db, { knowledgeBaseId: entA, name: 'a.txt', userId: owner });
  const entADoc = await createDoc(db, {
    content: 'enterprise A secret page',
    knowledgeBaseId: entA,
    parentId: entAFolder,
    title: 'Page A',
    userId: owner,
  });
  const entBFile = await createKbFile(db, { knowledgeBaseId: entB, name: 'b.txt', userId: owner });
  const personalFile = await createKbFile(db, {
    knowledgeBaseId: personalKb,
    name: 'personal.txt',
    userId: owner,
  });

  enterpriseKbState.kbs.set(entA, {
    grants: { [editor]: 'edit', [viewer]: 'view' },
    ownerId: owner,
  });
  enterpriseKbState.kbs.set(entB, { grants: {}, ownerId: owner });

  return {
    editor,
    entA,
    entAFile,
    entADoc,
    entAFolder,
    entB,
    entBFile,
    owner,
    personalFile,
    personalKb,
    stranger,
    viewer,
  };
};
