'use client';

import type { BuiltinRenderProps } from '@lobechat/types';
import { Empty, Flexbox, Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { SearchKnowledgeBaseArgs, SearchKnowledgeBaseState } from '../../../types';
import FileItem from './Item';

const SearchKnowledgeBase = memo<
  BuiltinRenderProps<SearchKnowledgeBaseArgs, SearchKnowledgeBaseState>
>(({ pluginState }) => {
  const { t } = useTranslation('plugin');
  const { fileResults, scope, skippedKnowledgeBaseCount } = pluginState || {};
  const warning = skippedKnowledgeBaseCount ? (
    <Text fontSize={12} type="secondary">
      {t('builtins.lobe-knowledge-base.render.skippedKnowledgeBases')}
    </Text>
  ) : null;

  // Nothing was searched — saying "No results" would read as "the files don't
  // contain it" when the agent simply has no library to look in.
  if (scope === 'none') {
    return (
      <Flexbox gap={8}>
        {warning}
        <Empty description={t('builtins.lobe-knowledge-base.render.noScope')} />
      </Flexbox>
    );
  }

  if (!fileResults || fileResults.length === 0) {
    return (
      <Flexbox gap={8}>
        {warning}
        <Empty description={t('builtins.lobe-knowledge-base.inspector.noResults')} />
      </Flexbox>
    );
  }

  return (
    <Flexbox gap={8}>
      {warning}
      <Flexbox horizontal gap={8} wrap={'wrap'}>
        {fileResults.map((file, index) => {
          return <FileItem index={index} key={file.fileId} {...file} />;
        })}
      </Flexbox>
    </Flexbox>
  );
});

export default SearchKnowledgeBase;
