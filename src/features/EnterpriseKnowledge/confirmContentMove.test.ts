import type { KnowledgeBaseItem } from '@lobechat/types';
import i18next from 'i18next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../locales/en-US/knowledgeBase.json';
import zh from '../../../locales/zh-CN/knowledgeBase.json';
import {
  confirmContentMove,
  getMoveOutMenuItems,
  selectContentMoveTarget,
} from './confirmContentMove';

interface ConfirmOptions {
  cancelText: string;
  content: string;
  okText: string;
  onOk: () => Promise<void>;
  title: string;
}
const mocks = vi.hoisted(() => ({
  confirm: vi.fn<(options: ConfirmOptions) => void>(),
  picker: vi.fn(),
  moveIn: vi.fn(),
  moveOut: vi.fn(),
  refresh: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@lobehub/ui', () => ({
  confirmModal: mocks.confirm,
  toast: { success: vi.fn(), error: mocks.error, warning: vi.fn() },
}));
vi.mock('@/features/ResourceManager/components/Explorer/MoveToFolderModal', () => ({
  openMoveToFolderModal: mocks.picker,
}));
vi.mock('@/services/enterpriseKnowledge', () => ({
  enterpriseKnowledgeService: { moveIn: mocks.moveIn, moveOut: mocks.moveOut },
}));
vi.mock('@/features/ResourceManager/store', () => ({
  useResourceManagerStore: {
    getState: () => ({ removeSearchHits: vi.fn(), clearSelectAllState: vi.fn() }),
  },
}));
vi.mock('@/store/file', () => ({
  useFileStore: { getState: () => ({ queryParams: {}, refreshFileList: mocks.refresh }) },
}));
vi.mock('@/store/library', () => ({
  useKnowledgeBaseStore: { getState: () => ({ refreshKnowledgeBaseList: mocks.refresh }) },
}));
vi.mock('@/store/tree', () => ({
  useTreeStore: { getState: () => ({ dropNodes: vi.fn(), forgetLibrary: vi.fn() }) },
}));

describe('enterprise ownership-change confirmation', () => {
  beforeAll(async () => {
    await i18next.init({
      lng: 'zh-CN',
      resources: {
        'zh-CN': { knowledgeBase: zh, common: { cancel: '取消' } },
        'en-US': { knowledgeBase: en, common: { cancel: 'Cancel' } },
      },
    });
  });
  beforeEach(async () => {
    await i18next.changeLanguage('zh-CN');
    vi.clearAllMocks();
    mocks.moveIn.mockResolvedValue({ items: [] });
    mocks.moveOut.mockResolvedValue({ items: [] });
  });
  it.each(['in', 'out'] as const)(
    'opens a confirmation first and sends nothing when move %s is cancelled',
    async (direction) => {
      const getIds = vi.fn(async () => ['file_1']);
      confirmContentMove({
        direction,
        count: 1,
        knowledgeBaseId: 'kb_1',
        libraryName: '研发规范',
        getIds,
      });
      expect(mocks.confirm).toHaveBeenCalledOnce();
      const options = mocks.confirm.mock.calls[0][0];
      expect(options.cancelText).toBe('取消');
      // Dismissing the modal never invokes onOk. Merely opening it must not even resolve IDs.
      await Promise.resolve();
      expect(getIds).not.toHaveBeenCalled();
      expect(mocks.moveIn).not.toHaveBeenCalled();
      expect(mocks.moveOut).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['in', 1],
    ['in', 3],
    ['out', 1],
    ['out', 3],
  ] as const)(
    'uses the ownership warning for move %s of %s items and mutates only after confirmation',
    async (direction, count) => {
      const ids = Array.from({ length: count }, (_, i) => `file_${i}`);
      confirmContentMove({
        direction,
        count,
        knowledgeBaseId: 'kb_1',
        libraryName: '研发规范',
        getIds: async () => ids,
      });
      const options = mocks.confirm.mock.calls[0][0];
      expect(options.content).toContain(`这 ${count} 项内容`);
      expect(options.content).toContain('共享知识库');
      expect(options.content).toContain('负责人所有');
      expect(options.content).toContain(direction === 'in' ? '原件会被删除' : '归你所有的个人副本');
      expect(options.title).toContain('？');
      expect(options.okText).toBe(direction === 'in' ? '移入' : '移出');
      expect(mocks.moveIn).not.toHaveBeenCalled();
      expect(mocks.moveOut).not.toHaveBeenCalled();
      await options.onOk();
      expect(direction === 'in' ? mocks.moveIn : mocks.moveOut).toHaveBeenCalledWith({
        ids,
        knowledgeBaseId: 'kb_1',
        parentId: undefined,
      });
    },
  );
  it('confirms only after the user selects an editable move-in destination', async () => {
    await selectContentMoveTarget({
      direction: 'in',
      count: 1,
      knowledgeBaseId: 'kb_1',
      libraryName: '研发规范',
      getIds: async () => ['file_1'],
    });
    expect(mocks.confirm).not.toHaveBeenCalled();
    mocks.picker.mock.calls[0][0].onMove('docs_folder');
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.moveIn).not.toHaveBeenCalled();
  });
  it('lets the member pick a folder in their chosen personal library before confirming a move out', async () => {
    await selectContentMoveTarget({
      direction: 'out',
      count: 2,
      knowledgeBaseId: 'kb_1',
      libraryName: '研发规范',
      targetKnowledgeBaseId: 'kb_personal',
      targetLabel: '个人资料库',
      getIds: async () => ['file_1', 'docs_2'],
    });
    const picker = mocks.picker.mock.calls[0][0];
    expect(picker.knowledgeBaseId).toBe('kb_personal');
    expect(picker.title).toBe('选择「个人资料库」中的位置');
    expect(mocks.confirm).not.toHaveBeenCalled();
    picker.onMove('docs_personal', '项目说明');
    expect(mocks.confirm.mock.calls[0][0].content).toContain('个人资料库 / 项目说明');
    await mocks.confirm.mock.calls[0][0].onOk();
    expect(mocks.moveOut).toHaveBeenCalledWith({
      ids: ['file_1', 'docs_2'],
      knowledgeBaseId: 'kb_1',
      parentId: 'docs_personal',
      targetKnowledgeBaseId: 'kb_personal',
    });
  });
  it('confirms resource-root moves directly without opening the removed personal-folder picker', async () => {
    await selectContentMoveTarget({
      direction: 'out',
      count: 1,
      knowledgeBaseId: 'kb_1',
      libraryName: '研发规范',
      getIds: async () => ['file_1'],
    });
    expect(mocks.picker).not.toHaveBeenCalled();
    expect(mocks.confirm.mock.calls[0][0].content).toContain('副本将放在「资源根目录」');
    expect(mocks.moveOut).not.toHaveBeenCalled();
    await mocks.confirm.mock.calls[0][0].onOk();
    expect(mocks.moveOut).toHaveBeenCalledWith({
      ids: ['file_1'],
      knowledgeBaseId: 'kb_1',
      parentId: null,
    });
  });
  it('offers resource root first and only the caller’s ordinary libraries, with no request on cancellation', async () => {
    const getIds = vi.fn(async () => ['file_1', 'file_2']);
    const libraries = [
      { id: 'mine', name: '个人资料库', userId: 'me' },
      { id: 'foreign', name: '他人的库', userId: 'other' },
      {
        id: 'enterprise',
        name: '我的企业库',
        userId: 'me',
        enterprise: { accessLevel: 'owner', ownerName: 'Me' },
      },
      { id: 'revoked', name: '已撤权', userId: 'me', accessRevoked: true },
    ] as KnowledgeBaseItem[];
    const params = {
      count: 2,
      getIds,
      knowledgeBaseId: 'kb_1',
      libraryName: '研发规范',
      libraries,
      userId: 'me',
    };
    const menu = getMoveOutMenuItems(params);
    expect(menu.map((item) => item.key)).toEqual([
      'move-out-resource-root',
      'move-out-library-mine',
    ]);
    const root = menu[0] as { onClick: () => void };
    root.onClick();
    expect(mocks.confirm.mock.calls[0][0].content).toContain('副本将放在「资源根目录」');
    expect(getIds).not.toHaveBeenCalled();
    expect(mocks.moveOut).not.toHaveBeenCalled();
    await mocks.confirm.mock.calls[0][0].onOk();
    expect(mocks.moveOut).toHaveBeenCalledWith({
      ids: ['file_1', 'file_2'],
      knowledgeBaseId: 'kb_1',
      parentId: null,
      targetKnowledgeBaseId: null,
    });
    vi.clearAllMocks();
    await (menu[1] as { onClick: () => Promise<void> }).onClick();
    expect(mocks.picker.mock.calls[0][0].knowledgeBaseId).toBe('mine');
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.moveOut).not.toHaveBeenCalled();
    expect(getMoveOutMenuItems({ ...params, workspaceId: 'ws_1' })).toEqual([]);
  });
  it.each([
    ['NOT_FOUND', '无法移动：内容不存在或你没有编辑权限。'],
    ['FORBIDDEN', '所选条目中有只读内容，请选择可编辑的条目后操作。'],
  ])('distinguishes %s from an ordinary read-only refusal', async (code, message) => {
    mocks.moveOut.mockRejectedValueOnce({ data: { code } });
    confirmContentMove({
      direction: 'out',
      count: 1,
      knowledgeBaseId: 'kb_1',
      libraryName: '研发规范',
      getIds: async () => ['file_1'],
    });
    await expect(mocks.confirm.mock.calls[0][0].onOk()).rejects.toMatchObject({ data: { code } });
    expect(mocks.error).toHaveBeenCalledWith(message);
  });
  it('shows the English ownership change and original destination before confirming', async () => {
    await i18next.changeLanguage('en-US');
    confirmContentMove({
      direction: 'out',
      count: 3,
      knowledgeBaseId: 'kb_1',
      libraryName: 'Engineering',
      getIds: async () => ['file_1'],
    });
    const options = mocks.confirm.mock.calls[0][0];
    expect(options.title).toBe('Move to my resources?');
    expect(options.content).toContain('3 items');
    expect(options.content).toContain('shared knowledge base "Engineering"');
    expect(options.content).toContain('personal copy that you own');
    expect(options.content).toContain('knowledge base trash');
    expect(options.okText).toBe('Move out');
    expect(options.cancelText).toBe('Cancel');
    expect(mocks.moveOut).not.toHaveBeenCalled();
  });
  it('keeps a failed mutation retryable without changing local lists', async () => {
    mocks.moveIn.mockRejectedValueOnce(new Error('network failed'));
    confirmContentMove({
      direction: 'in',
      count: 1,
      knowledgeBaseId: 'kb_1',
      libraryName: '研发规范',
      getIds: async () => ['file_1'],
    });
    await expect(mocks.confirm.mock.calls[0][0].onOk()).rejects.toThrow('network failed');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
