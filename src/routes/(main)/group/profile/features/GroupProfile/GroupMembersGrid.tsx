'use client';

import { ActionIcon, Avatar, DropdownMenu, Flexbox, Icon, Text } from '@lobehub/ui';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { MoreHorizontalIcon, PencilIcon, UserMinusIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { brandIcon } from '@/components/BrandIcon';
import { usePermission } from '@/hooks/usePermission';
import { parseAsString, useQueryState } from '@/hooks/useQueryParam';
import { useAgentGroupStore } from '@/store/agentGroup';
import { agentGroupSelectors } from '@/store/agentGroup/selectors';

const styles = stylex.create({
  body: {
    display: 'flex',
    flex: '1',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
  },
  card: {
    alignItems: 'flex-start',
    backgroundColor: {
      'default': cssVar.colorFillQuaternary,
      ':hover': cssVar.colorFillTertiary,
    },
    borderRadius: cssVar.borderRadiusLG,
    cursor: 'pointer',
    display: 'flex',
    gap: 12,
    minWidth: 0,
    outlineColor: cssVar.colorPrimaryBorder,
    outlineOffset: 1,
    outlineStyle: { 'default': 'none', ':focus-visible': 'solid' },
    outlineWidth: 2,
    padding: 16,
    transitionDuration: '0.15s',
    transitionProperty: 'background-color',
  },
  desc: {
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    color: cssVar.colorTextTertiary,
    display: '-webkit-box',
    fontSize: 12,
    lineHeight: '20px',
    overflow: 'hidden',
  },
  // Three across at the page's usual width, two when it narrows.
  grid: {
    display: 'grid',
    gap: 12,
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  },
});

/**
 * The group's members as cards, three to a row: who is in the group and what
 * each one does, read at a glance before the shared instructions. A card opens
 * that member's settings, the same place its tab leads to.
 */
const GroupMembersGrid = memo(() => {
  const { t } = useTranslation(['setting', 'chat']);
  const { allowed: canEdit } = usePermission('edit_own_content');
  const { gid } = useParams<{ gid: string }>();
  const members = useAgentGroupStore((s) => agentGroupSelectors.getGroupAgents(gid ?? '')(s));
  const removeAgentFromGroup = useAgentGroupStore((s) => s.removeAgentFromGroup);
  const [, setSelectedTabId] = useQueryState('tab', parseAsString.withDefault('group'));

  const visible = members.filter((member) => !member.isSupervisor);

  return (
    <Flexbox data-brand-slot={'group-members'} gap={12}>
      <Flexbox horizontal align={'baseline'} gap={8}>
        <Text strong fontSize={14}>
          {t('settingGroupMembers.groupMembers', { ns: 'setting' })}
        </Text>
        <Text fontSize={12} type={'secondary'}>
          {visible.length}
        </Text>
      </Flexbox>
      {visible.length === 0 ? (
        <Text fontSize={12} type={'secondary'}>
          {t('group.profile.membersEmpty', { ns: 'chat' })}
        </Text>
      ) : (
        <div {...stylex.props(styles.grid)}>
          {visible.map((member) => {
            const title =
              member.title || t('group.profile.addMember.newMemberTitle', { ns: 'chat' });
            const open = () => setSelectedTabId(member.id);

            return (
              <div
                key={member.id}
                role={'button'}
                tabIndex={0}
                onClick={open}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open();
                  }
                }}
                {...stylex.props(styles.card)}
              >
                <Avatar
                  avatar={member.avatar || undefined}
                  background={member.backgroundColor || undefined}
                  shape={'square'}
                  size={32}
                  title={title}
                />
                <div {...stylex.props(styles.body)}>
                  <Text ellipsis strong fontSize={14}>
                    {title}
                  </Text>
                  {member.description && (
                    <div {...stylex.props(styles.desc)}>{member.description}</div>
                  )}
                </div>
                {canEdit && gid && (
                  <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    <DropdownMenu
                      items={[
                        {
                          icon: <Icon icon={PencilIcon} />,
                          key: 'edit',
                          label: t('group.profile.member.edit', { ns: 'chat' }),
                          onClick: open,
                        },
                        {
                          danger: true,
                          icon: <Icon icon={UserMinusIcon} />,
                          key: 'remove',
                          label: t('group.profile.member.remove', { ns: 'chat' }),
                          onClick: () => removeAgentFromGroup(gid, member.id),
                        },
                      ]}
                    >
                      <ActionIcon
                        aria-label={t('group.profile.member.actions', { ns: 'chat', name: title })}
                        icon={brandIcon('action.more', MoreHorizontalIcon)}
                        size={'small'}
                      />
                    </DropdownMenu>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Flexbox>
  );
});

GroupMembersGrid.displayName = 'GroupMembersGrid';

export default GroupMembersGrid;
