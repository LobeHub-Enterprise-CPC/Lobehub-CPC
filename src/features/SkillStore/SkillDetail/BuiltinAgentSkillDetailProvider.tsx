'use client';

import { BRANDING_NAME } from '@lobechat/business-const';
import isEqual from 'fast-deep-equal';
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import { OFFICIAL_SITE } from '@/const/url';
import { useToolStore } from '@/store/tool';
import { loadBuiltinSkill } from '@/store/tool/slices/builtin/loadBuiltinSkills';
import { vendorLink } from '@/utils/vendorLink';

import { DetailContext, type DetailContextValue } from './DetailContext';

interface BuiltinAgentSkillDetailProviderProps {
  children: ReactNode;
  identifier: string;
}

export const BuiltinAgentSkillDetailProvider = ({
  children,
  identifier,
}: BuiltinAgentSkillDetailProviderProps) => {
  const { t } = useTranslation(['setting']);

  const builtinSkills = useToolStore((s) => s.builtinSkills, isEqual);

  const skill = useMemo(
    () => builtinSkills.find((s) => s.identifier === identifier),
    [identifier, builtinSkills],
  );

  const { data: skillContent } = useSWR(
    skill ? ['builtin-skill-content', identifier] : null,
    async () => (await loadBuiltinSkill(identifier))?.content,
    { revalidateOnFocus: false },
  );

  if (!skill) return null;

  const localizedTitle = t(`tools.builtins.${identifier}.title`, {
    defaultValue: skill.name,
  });
  const localizedDescription = t(`tools.builtins.${identifier}.description`, {
    defaultValue: skill.description,
  });
  const localizedReadme = t(`tools.builtins.${identifier}.readme`, {
    defaultValue: '',
  });

  const value: DetailContextValue = {
    author: BRANDING_NAME,
    authorUrl: vendorLink(OFFICIAL_SITE),
    config: null as any,
    description: skill.description,
    icon: skill.avatar || '',
    identifier,
    isConnected: true,
    label: localizedTitle,
    localizedDescription,
    localizedReadme,
    readme: '',
    skillContent,
    tools: [],
    toolsLoading: false,
  };

  return <DetailContext value={value}>{children}</DetailContext>;
};
