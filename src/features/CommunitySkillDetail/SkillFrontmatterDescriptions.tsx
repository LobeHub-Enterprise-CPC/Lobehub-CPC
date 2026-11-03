'use client';

import { cssVar, Descriptions, Highlighter } from '@lobehub/ui';
import { memo, useMemo } from 'react';

import { parseSkillMarkdownMetadata } from '@/utils/skillMarkdown';

interface SkillFrontmatterDescriptionsProps {
  frontmatter: string;
}

/**
 * A SKILL.md's frontmatter as field/value rows above its body. Rendered as
 * Markdown it would turn into one oversized heading, so the caller splits it
 * off and shows it here instead.
 */
const SkillFrontmatterDescriptions = memo<SkillFrontmatterDescriptionsProps>(({ frontmatter }) => {
  const metadata = useMemo(() => parseSkillMarkdownMetadata(frontmatter), [frontmatter]);

  // Unreadable YAML still shows as written rather than disappearing.
  if (metadata.length === 0)
    return (
      <Highlighter language={'yaml'} style={{ marginBlockEnd: 16 }} variant={'outlined'}>
        {frontmatter}
      </Highlighter>
    );

  return (
    <Descriptions
      bordered
      colon={false}
      items={metadata.map(({ key, value }) => ({ children: value, key, label: key }))}
      style={{ marginBlockEnd: 16 }}
      styles={{
        content: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
        label: { fontFamily: cssVar.fontFamilyCode, whiteSpace: 'nowrap' },
      }}
    />
  );
});

SkillFrontmatterDescriptions.displayName = 'SkillFrontmatterDescriptions';

export default SkillFrontmatterDescriptions;
