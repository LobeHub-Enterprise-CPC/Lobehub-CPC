'use client';

import { Avatar } from '@lobehub/ui';
import * as stylex from '@stylexjs/stylex';
import dayjs from 'dayjs';
import {
  ArrowUpRightIcon,
  FileTextIcon,
  InfoIcon,
  LayoutGridIcon,
  StickyNoteIcon,
} from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { brandIcon } from '@/components/BrandIcon';
import { InstallButton } from '@/features/CommunitySkillDetail/Header';
import { useSkillCategoryItem } from '@/hooks/useSkillCategory';
import { type DiscoverSkillDetail } from '@/types/discover';

import { blockStyles } from '../../features/Showcase/detail/blocks';
import DetailFrame from '../../features/Showcase/detail/DetailFrame';
import DetailSection from '../../features/Showcase/detail/DetailSection';
import InfoGrid from '../../features/Showcase/detail/InfoGrid';
import MarkdownRender from '../features/MakedownRender';
import ShareButton from '../features/ShareButton';

const Icons = {
  description: brandIcon('community.description', StickyNoteIcon),
  info: brandIcon('community.info', InfoIcon),
  overview: brandIcon('community.overview', LayoutGridIcon),
  skillFile: brandIcon('community.skillFile', FileTextIcon),
};

/** The showcase skill page: overview (description and facts) and its SKILL.md. */
const ShowcaseSkillDetail = memo<{ data: DiscoverSkillDetail }>(({ data }) => {
  const { t } = useTranslation('discover');
  const [tab, setTab] = useState('overview');
  const category = useSkillCategoryItem(data.category)?.label;
  const author = (data.author as any)?.name ?? (data.author as unknown as string | undefined);
  const date = data.updatedAt || data.createdAt;
  const version = (data as any).version ?? (data.manifest as any)?.version;
  const source = data.github?.url || (data as any).repository;

  return (
    <DetailFrame
      activeTab={tab}
      avatar={<Avatar avatar={data.icon || data.name} shape={'square'} size={64} />}
      kind={'skill'}
      share={<ShareButton meta={{ avatar: data.icon, desc: data.description, title: data.name }} />}
      title={data.name}
      install={
        <InstallButton
          identifier={data.identifier}
          label={t('showcase.install.skill')}
          name={data.name}
        />
      }
      meta={[
        author,
        category,
        date
          ? t('showcase.detail.updatedAt', { date: dayjs(date).format('YYYY-MM-DD') })
          : undefined,
      ]}
      prompt={t('showcase.copyPrompt.template.skill', {
        content: data.content ?? '',
        description: data.description,
        interpolation: { escapeValue: false },
        name: data.name,
      })}
      tabs={[
        { icon: Icons.overview, key: 'overview', label: t('showcase.detail.overview') },
        { icon: Icons.skillFile, key: 'skill', label: t('showcase.detail.skillMd') },
      ]}
      onTabChange={setTab}
    >
      {tab === 'overview' && (
        <>
          <DetailSection icon={Icons.description} title={t('showcase.detail.skillDescription')}>
            <p {...stylex.props(blockStyles.text)}>{data.description}</p>
          </DetailSection>
          <DetailSection icon={Icons.info} title={t('showcase.detail.skillInfo')}>
            <InfoGrid
              items={[
                { label: t('showcase.info.publisher'), value: author },
                { label: t('showcase.info.category'), value: category },
                { label: t('showcase.info.version'), value: version },
                {
                  label: t('showcase.info.updatedAt'),
                  value: date ? dayjs(date).format('YYYY-MM-DD') : undefined,
                },
                {
                  label: t('showcase.info.license'),
                  value: typeof data.license === 'string' ? data.license : data.license?.name,
                },
                { label: t('showcase.info.installs'), value: data.installCount?.toLocaleString() },
                { label: t('showcase.info.stars'), value: data.github?.stars?.toLocaleString() },
                {
                  label: t('showcase.info.source'),
                  value: source ? (
                    <a href={source} rel={'noreferrer'} target={'_blank'}>
                      {t('showcase.info.sourceLink')} <ArrowUpRightIcon size={14} />
                    </a>
                  ) : undefined,
                },
              ]}
            />
          </DetailSection>
        </>
      )}
      {tab === 'skill' && (
        <div {...stylex.props(blockStyles.tinted, blockStyles.markdown)}>
          <MarkdownRender>{data.content}</MarkdownRender>
        </div>
      )}
    </DetailFrame>
  );
});

ShowcaseSkillDetail.displayName = 'ShowcaseSkillDetail';

export default ShowcaseSkillDetail;
