'use client';

import { Avatar } from '@lobehub/ui';
import { SkillsIcon } from '@lobehub/ui/icons';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import dayjs from 'dayjs';
import { GitForkIcon, LayoutGridIcon, PackageIcon, QuoteIcon, StickyNoteIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { brandIcon } from '@/components/BrandIcon';
import MCPInstallProgress from '@/features/MCP/MCPInstallProgress';
import { useCategoryItem } from '@/hooks/useMCPCategory';
import { type DiscoverMcpDetail } from '@/types/discover';

import { blockStyles, Tile, VersionList } from '../../features/Showcase/detail/blocks';
import DetailFrame from '../../features/Showcase/detail/DetailFrame';
import DetailSection from '../../features/Showcase/detail/DetailSection';
import MarkdownRender from '../features/MakedownRender';
import ShareButton from '../features/ShareButton';
import ActionButton from './features/Sidebar/ActionButton';

const Icons = {
  description: brandIcon('community.description', StickyNoteIcon),
  overview: brandIcon('community.overview', LayoutGridIcon),
  prompts: brandIcon('community.prompts', QuoteIcon),
  resources: brandIcon('community.resources', PackageIcon),
  tools: brandIcon('community.skill', SkillsIcon),
  versions: brandIcon('community.versions', GitForkIcon),
};

const tableStyles = stylex.create({
  cell: {
    borderBlockStartColor: cssVar.colorBorderSecondary,
    borderBlockStartStyle: 'solid',
    borderBlockStartWidth: 1,
    color: cssVar.colorText,
    fontSize: 14,
    lineHeight: '22px',
    paddingBlock: 16,
    paddingInline: 24,
    textAlign: 'start',
    verticalAlign: 'middle',
  },
  head: {
    backgroundColor: cssVar.colorFillQuaternary,
    color: cssVar.colorTextSecondary,
    fontSize: 14,
    fontWeight: 500,
    paddingBlock: 12,
    paddingInline: 24,
    textAlign: 'start',
  },
  mime: {
    backgroundColor: cssVar.colorFillTertiary,
    borderRadius: 4,
    fontSize: 12,
    paddingInline: 4,
  },
  table: {
    borderCollapse: 'separate',
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: 12,
    borderSpacing: 0,
    borderStyle: 'solid',
    borderWidth: 1,
    overflow: 'hidden',
    width: '100%',
  },
});

/**
 * The showcase connector page: overview (description, tools, prompts and
 * resources) and version history, with "install connector" as the action.
 */
const ShowcaseMcpDetail = memo<{ data: DiscoverMcpDetail }>(({ data }) => {
  const { t } = useTranslation('discover');
  const categoryLabel = useCategoryItem(data.category)?.label;
  const [tab, setTab] = useState('overview');
  const tools = data.tools ?? [];
  const prompts = data.prompts ?? [];
  const resources = data.resources ?? [];
  const date = data.updatedAt || data.createdAt;
  const author = typeof data.author === 'string' ? data.author : (data.author as any)?.name;

  return (
    <DetailFrame
      actionsExtra={<MCPInstallProgress identifier={data.identifier} />}
      activeTab={tab}
      avatar={<Avatar avatar={data.icon} shape={'square'} size={64} />}
      install={<ActionButton label={t('showcase.install.mcp')} showProgress={false} />}
      kind={'mcp'}
      share={<ShareButton meta={{ avatar: data.icon, desc: data.description, title: data.name }} />}
      title={data.name}
      meta={[
        author,
        categoryLabel,
        date
          ? t('showcase.detail.updatedAt', { date: dayjs(date).format('YYYY-MM-DD') })
          : undefined,
      ]}
      prompt={t('showcase.copyPrompt.template.mcp', {
        description: data.description,
        identifier: data.identifier,
        interpolation: { escapeValue: false },
        name: data.name,
        tools: tools.map((tool) => tool.name).join(', '),
      })}
      tabs={[
        { icon: Icons.overview, key: 'overview', label: t('showcase.detail.overview') },
        { icon: Icons.versions, key: 'versions', label: t('showcase.detail.versions') },
      ]}
      onTabChange={setTab}
    >
      {tab === 'overview' && (
        <>
          <DetailSection icon={Icons.description} title={t('showcase.detail.connectorDescription')}>
            {data.overview?.readme ? (
              <MarkdownRender>{data.overview.readme}</MarkdownRender>
            ) : (
              <p {...stylex.props(blockStyles.text)}>{data.description}</p>
            )}
          </DetailSection>
          {tools.length > 0 && (
            <DetailSection
              count={tools.length}
              icon={Icons.tools}
              title={t('showcase.detail.builtinSkills')}
            >
              <div {...stylex.props(blockStyles.grid3)}>
                {tools.map((tool) => (
                  <Tile description={tool.description} key={tool.name} title={tool.name} />
                ))}
              </div>
            </DetailSection>
          )}
          {prompts.length > 0 && (
            <DetailSection
              count={prompts.length}
              icon={Icons.prompts}
              title={t('showcase.detail.prompts')}
            >
              <div {...stylex.props(blockStyles.grid3)}>
                {prompts.map((prompt) => (
                  <Tile description={prompt.description} key={prompt.name} title={prompt.name} />
                ))}
              </div>
            </DetailSection>
          )}
          {resources.length > 0 && (
            <DetailSection
              count={resources.length}
              icon={Icons.resources}
              title={t('showcase.detail.resources')}
            >
              <table {...stylex.props(tableStyles.table)}>
                <thead>
                  <tr>
                    <th {...stylex.props(tableStyles.head)}>{t('showcase.detail.resourceName')}</th>
                    <th {...stylex.props(tableStyles.head)}>{t('showcase.detail.resourceMime')}</th>
                    <th {...stylex.props(tableStyles.head)}>{t('showcase.detail.resourceUrl')}</th>
                    <th {...stylex.props(tableStyles.head)}>
                      {t('showcase.detail.resourceDescription')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {resources.map((resource: any) => (
                    <tr key={resource.uri}>
                      <td {...stylex.props(tableStyles.cell)}>{resource.name}</td>
                      <td {...stylex.props(tableStyles.cell)}>
                        {resource.mimeType && (
                          <span {...stylex.props(tableStyles.mime)}>{resource.mimeType}</span>
                        )}
                      </td>
                      <td {...stylex.props(tableStyles.cell)}>{resource.uri}</td>
                      <td {...stylex.props(tableStyles.cell)}>{resource.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DetailSection>
          )}
        </>
      )}
      {tab === 'versions' && <VersionList versions={(data as any).versions ?? []} />}
    </DetailFrame>
  );
});

ShowcaseMcpDetail.displayName = 'ShowcaseMcpDetail';

export default ShowcaseMcpDetail;
