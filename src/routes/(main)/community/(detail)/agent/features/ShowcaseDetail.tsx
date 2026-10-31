'use client';

import { Avatar } from '@lobehub/ui';
import { SkillsIcon } from '@lobehub/ui/icons';
import * as stylex from '@stylexjs/stylex';
import dayjs from 'dayjs';
import {
  BookOpenIcon,
  FileTextIcon,
  GitForkIcon,
  LayoutGridIcon,
  MessageCircleIcon,
  MessageCircleQuestionIcon,
  QuoteIcon,
  StickyNoteIcon,
} from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { brandIcon } from '@/components/BrandIcon';
import { useDiscoverStore } from '@/store/discover';
import { skillSelectors } from '@/store/discover/selectors';

import { useCategoryItem } from '../../../(list)/agent/features/Category/useCategory';
import { blockStyles, Tile, VersionList } from '../../../features/Showcase/detail/blocks';
import DetailFrame from '../../../features/Showcase/detail/DetailFrame';
import DetailSection from '../../../features/Showcase/detail/DetailSection';
import ShareButton from '../../features/ShareButton';
import { useDetailContext } from './DetailProvider';
import ForkAndChat from './Sidebar/ActionButton/ForkAndChat';

const Icons = {
  config: brandIcon('community.config', FileTextIcon),
  description: brandIcon('community.description', StickyNoteIcon),
  library: brandIcon('community.library', BookOpenIcon),
  opening: brandIcon('community.opening', MessageCircleIcon),
  overview: brandIcon('community.overview', LayoutGridIcon),
  prompt: brandIcon('community.prompts', QuoteIcon),
  questions: brandIcon('community.questions', MessageCircleQuestionIcon),
  skill: brandIcon('community.skill', SkillsIcon),
  versions: brandIcon('community.versions', GitForkIcon),
};

/** A built-in skill, named and described from the market when it is one. */
const SkillTile = memo<{ identifier: string }>(({ identifier }) => {
  const useSkillDetail = useDiscoverStore((s) => s.useFetchSkillDetail);
  const { queryKey } = useSkillDetail({ identifier });
  const skill = useDiscoverStore(skillSelectors.skillDetail(queryKey));

  return (
    <Tile
      description={skill?.description}
      title={skill?.name || identifier}
      extra={
        skill?.icon ? (
          <Avatar avatar={skill.icon} shape={'square'} size={24} style={{ marginInlineEnd: 8 }} />
        ) : undefined
      }
    />
  );
});

/**
 * The showcase assistant page: overview (description, built-in skills,
 * libraries), configuration (prompt, opening message and questions) and
 * version history, with "install assistant" as the primary action.
 */
const ShowcaseAgentDetail = memo(() => {
  const { t } = useTranslation('discover');
  const detail = useDetailContext();
  const {
    author,
    avatar,
    backgroundColor,
    category,
    config,
    createdAt,
    description,
    knowledgeCount,
    summary,
    title = '',
    updatedAt,
    versions = [],
  } = detail as any;
  const categoryLabel = useCategoryItem(category)?.label;
  const [tab, setTab] = useState('overview');
  const plugins: string[] = (config?.plugins ?? []).map((plugin: any) =>
    typeof plugin === 'string' ? plugin : plugin?.identifier,
  );
  const questions: string[] = config?.openingQuestions ?? [];
  const date = updatedAt || createdAt;

  return (
    <DetailFrame
      activeTab={tab}
      install={<ForkAndChat label={t('showcase.install.agent')} />}
      kind={'agent'}
      share={<ShareButton meta={{ avatar, desc: description, title, url: location.href }} />}
      title={title}
      avatar={
        <Avatar
          avatar={avatar}
          background={backgroundColor || 'transparent'}
          shape={'square'}
          size={64}
        />
      }
      meta={[
        typeof author === 'string' ? author : author?.name,
        categoryLabel,
        date
          ? t('showcase.detail.updatedAt', { date: dayjs(date).format('YYYY-MM-DD') })
          : undefined,
      ]}
      prompt={t('showcase.copyPrompt.template.agent', {
        description: description || summary || '',
        interpolation: { escapeValue: false },
        name: title,
        prompt: config?.systemRole ?? '',
      })}
      tabs={[
        { icon: Icons.overview, key: 'overview', label: t('showcase.detail.overview') },
        { icon: Icons.config, key: 'config', label: t('showcase.detail.agentConfig') },
        { icon: Icons.versions, key: 'versions', label: t('showcase.detail.versions') },
      ]}
      onTabChange={setTab}
    >
      {tab === 'overview' && (
        <>
          <DetailSection icon={Icons.description} title={t('showcase.detail.agentDescription')}>
            <p {...stylex.props(blockStyles.text)}>{summary || description}</p>
          </DetailSection>
          <DetailSection
            count={plugins.length}
            icon={Icons.skill}
            title={t('showcase.detail.builtinSkills')}
          >
            {plugins.length > 0 && (
              <div {...stylex.props(blockStyles.grid3)}>
                {plugins.map((id) => (
                  <SkillTile identifier={id} key={id} />
                ))}
              </div>
            )}
          </DetailSection>
          <DetailSection
            count={knowledgeCount ?? 0}
            icon={Icons.library}
            title={t('showcase.detail.library')}
          >
            <p {...stylex.props(blockStyles.muted)}>{t('showcase.detail.libraryDesc')}</p>
          </DetailSection>
        </>
      )}
      {tab === 'config' && (
        <>
          <DetailSection icon={Icons.prompt} title={t('showcase.detail.agentPrompt')}>
            <div {...stylex.props(blockStyles.tinted)}>{config?.systemRole}</div>
          </DetailSection>
          {config?.openingMessage && (
            <DetailSection icon={Icons.opening} title={t('showcase.detail.openingMessage')}>
              <div {...stylex.props(blockStyles.bordered)}>{config.openingMessage}</div>
            </DetailSection>
          )}
          {questions.length > 0 && (
            <DetailSection
              count={questions.length}
              icon={Icons.questions}
              title={t('showcase.detail.openingQuestions')}
            >
              <div {...stylex.props(blockStyles.grid2)}>
                {questions.map((question, index) => (
                  <div key={question} {...stylex.props(blockStyles.bordered, blockStyles.numbered)}>
                    <span {...stylex.props(blockStyles.number)}>{index + 1}</span>
                    {question}
                  </div>
                ))}
              </div>
            </DetailSection>
          )}
        </>
      )}
      {tab === 'versions' && <VersionList versions={versions} />}
    </DetailFrame>
  );
});

ShowcaseAgentDetail.displayName = 'ShowcaseAgentDetail';

export default ShowcaseAgentDetail;
