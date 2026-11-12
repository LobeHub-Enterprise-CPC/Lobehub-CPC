import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import enKnowledgeBase from '../../../locales/en-US/knowledgeBase.json';
import enPlugin from '../../../locales/en-US/plugin.json';
import enSetting from '../../../locales/en-US/setting.json';
import zhKnowledgeBase from '../../../locales/zh-CN/knowledgeBase.json';
import zhPlugin from '../../../locales/zh-CN/plugin.json';
import zhSetting from '../../../locales/zh-CN/setting.json';
import defaultKnowledgeBase from '../../../packages/locales/src/default/knowledgeBase';
import defaultPlugin from '../../../packages/locales/src/default/plugin';
import defaultSetting from '../../../packages/locales/src/default/setting';

describe('enterprise locale lookup with production keySeparator=false', () => {
  it.each([
    ['zh-CN', '企业知识库', '负责人', '部分知识库因权限未参与检索。', '文件'],
    [
      'en-US',
      'Enterprise knowledge bases',
      'Owner',
      'Some knowledge bases were excluded from search because of access permissions.',
      'File',
    ],
  ])(
    'resolves shipped %s resources instead of English fallback',
    async (lng, group, owner, skipped, file) => {
      const i18n = createInstance();
      await i18n.init({
        fallbackLng: 'en-US',
        interpolation: { escapeValue: false },
        keySeparator: false,
        lng,
        resources: {
          'en-US':
            lng === 'en-US'
              ? { knowledgeBase: enKnowledgeBase, plugin: enPlugin, setting: enSetting }
              : {
                  knowledgeBase: defaultKnowledgeBase,
                  plugin: defaultPlugin,
                  setting: defaultSetting,
                },
          'zh-CN': { knowledgeBase: zhKnowledgeBase, plugin: zhPlugin, setting: zhSetting },
        },
      });

      expect(i18n.t('enterprise.group', { ns: 'knowledgeBase' })).toBe(group);
      expect(i18n.t('enterprise.level.owner', { ns: 'knowledgeBase' })).toBe(owner);
      expect(
        i18n.t('builtins.lobe-knowledge-base.render.skippedKnowledgeBases', { ns: 'plugin' }),
      ).toBe(skipped);
      expect(i18n.t('trash.type.file', { ns: 'setting' })).toBe(file);
    },
  );
});
