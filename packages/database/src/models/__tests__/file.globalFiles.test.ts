// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { files, globalFiles, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { FileModel } from '../file';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'file-model-global-files-test-user-id';
const fileModel = new FileModel(serverDB, userId);

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values([{ id: userId }]);
});

afterEach(async () => {
  await serverDB.delete(files);
  await serverDB.delete(globalFiles);
  await serverDB.delete(users);
});

describe('FileModel global files', () => {
  describe('createGlobalFile', () => {
    it('should create a global file', async () => {
      const globalFile = {
        hashId: 'test-hash',
        fileType: 'text/plain',
        size: 100,
        url: 'https://example.com/global-file.txt',
        metadata: { key: 'value' },
        creator: userId,
      };

      const result = await fileModel.createGlobalFile(globalFile);
      expect(result[0]).toMatchObject(globalFile);
    });
  });

  describe('checkHash', () => {
    it('should return isExist: false for non-existent hash', async () => {
      const result = await fileModel.checkHash('non-existent-hash');
      expect(result).toEqual({ isExist: false });
    });

    it('should return file info for existing hash', async () => {
      const globalFile = {
        hashId: 'existing-hash',
        fileType: 'text/plain',
        size: 100,
        url: 'https://example.com/existing-file.txt',
        metadata: { key: 'value' },
        creator: userId,
      };

      await serverDB.insert(globalFiles).values(globalFile);

      const result = await fileModel.checkHash('existing-hash');
      expect(result).toEqual({
        isExist: true,
        fileType: 'text/plain',
        size: 100,
        url: 'https://example.com/existing-file.txt',
        metadata: { key: 'value' },
      });
    });

    it('should read through a provided transaction', async () => {
      // A row only the open transaction can see proves the read ran on it, not on another
      // pool connection.
      const result = await serverDB.transaction(async (trx) => {
        await trx.insert(globalFiles).values({
          creator: userId,
          fileType: 'text/plain',
          hashId: 'trx-hash',
          size: 100,
          url: 'files/trx.txt',
        });

        return fileModel.checkHash('trx-hash', trx);
      });

      expect(result).toMatchObject({ isExist: true, url: 'files/trx.txt' });
    });
  });

  describe('updateGlobalFile', () => {
    it('should update url and metadata of a global file by hashId', async () => {
      await fileModel.createGlobalFile({
        hashId: 'update-hash',
        fileType: 'text/plain',
        size: 100,
        url: 'https://example.com/old.txt',
        metadata: { version: 1 },
        creator: userId,
      });

      await fileModel.updateGlobalFile('update-hash', {
        url: 'https://example.com/new.txt',
        metadata: { version: 2 },
      });

      const updated = await serverDB.query.globalFiles.findFirst({
        where: eq(globalFiles.hashId, 'update-hash'),
      });

      expect(updated?.url).toBe('https://example.com/new.txt');
      expect(updated?.metadata).toEqual({ version: 2 });
    });

    it('should support running inside a provided transaction', async () => {
      await fileModel.createGlobalFile({
        hashId: 'trx-update-hash',
        fileType: 'text/plain',
        size: 100,
        url: 'https://example.com/old.txt',
        metadata: { version: 1 },
        creator: userId,
      });

      await serverDB.transaction(async (trx) => {
        await fileModel.updateGlobalFile(
          'trx-update-hash',
          { url: 'https://example.com/trx.txt' },
          trx,
        );
      });

      const updated = await serverDB.query.globalFiles.findFirst({
        where: eq(globalFiles.hashId, 'trx-update-hash'),
      });

      expect(updated?.url).toBe('https://example.com/trx.txt');
    });
  });
});
