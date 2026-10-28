'use client';

import { GROUP_PROFILE_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { DropdownMenu, Flexbox, Icon, Text, useTheme } from '@lobehub/ui';
import { ActionIcon, Button, Divider, type ModalInstance } from '@lobehub/ui';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import {
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  PlayIcon,
  Settings2Icon,
  UserPlusIcon,
  UsersIcon,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import urlJoin from 'url-join';

import { useAgentGroupTransferMenuItem } from '@/business/client/hooks/useAgentGroupTransferMenuItem';
import { useAgentGroupTransferToMemberMenuItem } from '@/business/client/hooks/useAgentGroupTransferToMemberMenuItem';
import { useHasActiveWorkspace } from '@/business/client/hooks/useHasActiveWorkspace';
import { brandIcon } from '@/components/BrandIcon';
import AddGroupMemberModal from '@/features/AddAgentMemberModal';
import { EditingIndicator, type EditLockClient, useEditLock } from '@/features/EditLock';
import { EditorCanvas } from '@/features/EditorCanvas';
import { useAdvancedModeMenuItem } from '@/features/NavPanel/useAdvancedModeMenuItem';
import AccessLevelTag from '@/features/ResourcePermission/AccessLevelTag';
import { useResourceAccess } from '@/features/ResourcePermission/useResourceAccess';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { usePermission } from '@/hooks/usePermission';
import { useQueryRoute } from '@/hooks/useQueryRoute';
import { lambdaClient } from '@/libs/trpc/client';
import { useAgentGroupStore } from '@/store/agentGroup';
import { agentGroupSelectors } from '@/store/agentGroup/selectors';
import { useGroupProfileStore } from '@/store/groupProfile';

import { openGroupAgentSettingsModal } from '../AgentSettings';
import AutoSaveHint from '../Header/AutoSaveHint';
import GroupForkTag from './GroupForkTag';
import GroupHeader from './GroupHeader';
import GroupMembersGrid from './GroupMembersGrid';
import GroupStatusTag from './GroupStatusTag';
import GroupVersionReviewTag from './GroupVersionReviewTag';

const styles = stylex.create({
  // The shared instructions as an outlined field, like the agent's core prompt.
  promptFrame: {
    backgroundColor: cssVar.colorBgContainer,
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: cssVar.borderRadiusLG,
    borderStyle: 'solid',
    borderWidth: 1,
    minHeight: 400,
    paddingBlock: 16,
    paddingInline: 18,
  },
});

// Stable lock RPC binding for the chatGroup resource.
const groupLockClient: EditLockClient = {
  acquire: (id) => lambdaClient.group.acquireGroupLock.mutate({ id }),
  peek: (id) => lambdaClient.group.getGroupLock.query({ id }),
  release: async (id) => {
    await lambdaClient.group.releaseGroupLock.mutate({ id });
  },
};

const GroupProfile = memo(() => {
  const { t } = useTranslation(['setting', 'chat']);
  const { allowed: hasEditPermission } = usePermission('edit_own_content');
  const theme = useTheme();
  const { gid } = useParams<{ gid: string }>();
  const groupId = useAgentGroupStore(agentGroupSelectors.activeGroupId);
  const hasActiveWorkspace = useHasActiveWorkspace();
  const currentGroup = useAgentGroupStore((s) => agentGroupSelectors.getGroupById(gid ?? '')(s));
  const updateGroup = useAgentGroupStore((s) => s.updateGroup);
  const router = useQueryRoute();
  // The profile page keeps its active tab in `?tab=`; the permission page has no
  // tabs, so navigate without carrying the query over (unlike `router.push`).
  const navigate = useWorkspaceAwareNavigate();
  const transferMenuItems = useAgentGroupTransferMenuItem(groupId ?? undefined);
  const transferToMemberItem = useAgentGroupTransferToMemberMenuItem(groupId ?? undefined);
  // A workspace member whose General access on this group is view/use level
  // can't edit it (defaults permissive while loading — server enforces).
  const { canEditResource } = useResourceAccess(
    'agentGroup',
    currentGroup?.visibility === 'private' ? undefined : (groupId ?? undefined),
  );
  const canEdit = hasEditPermission && canEditResource;

  // Member-permission entry lives inside the "..." menu and opens the dedicated
  // page, matching the agent profile header. Shown for private groups too: the
  // creator sets there what members get the moment the group is published.
  const showPermissionPageEntry = hasActiveWorkspace && !!groupId;
  const advancedModeMenuItem = useAdvancedModeMenuItem('group');
  const moreMenuItems = useMemo(() => {
    const permissionMenuItem = showPermissionPageEntry
      ? {
          // Same gate the page itself applies (ResourceConfigAccessGate):
          // without edit-level access it redirects straight back with a toast,
          // so an enabled entry here is a click into a dead end. Disabled, not
          // hidden — the member can still see the action exists.
          disabled: !canEdit,
          icon: <Icon icon={UsersIcon} />,
          key: 'permission',
          label: t('permission.page.entry', { ns: 'setting' }),
          onClick: () => {
            if (!canEdit || !groupId) return;
            navigate(urlJoin('/group', groupId, 'permission'));
          },
        }
      : null;

    return [
      advancedModeMenuItem,
      advancedModeMenuItem &&
      (permissionMenuItem || transferMenuItems?.length || transferToMemberItem)
        ? ({ type: 'divider' } as const)
        : null,
      permissionMenuItem,
      permissionMenuItem && (transferMenuItems?.length || transferToMemberItem)
        ? ({ type: 'divider' } as const)
        : null,
      ...(transferMenuItems ?? []),
      transferToMemberItem,
    ].filter(Boolean);
  }, [
    advancedModeMenuItem,
    canEdit,
    groupId,
    navigate,
    showPermissionPageEntry,
    t,
    transferMenuItems,
    transferToMemberItem,
  ]);

  const [showAddModal, setShowAddModal] = useState(false);
  const members = useAgentGroupStore((s) => agentGroupSelectors.getGroupAgents(gid ?? '')(s));
  const addAgentsToGroup = useAgentGroupStore((s) => s.addAgentsToGroup);
  const existingMemberIds = useMemo(() => members.map((member) => member.id), [members]);

  const settingsModalRef = useRef<ModalInstance | null>(null);
  useEffect(
    () => () => {
      settingsModalRef.current?.close();
      settingsModalRef.current = null;
    },
    [],
  );

  // Collaborative edit lock for workspace groups (same model as pages): read-only
  // when another member is editing; acquired implicitly on the first edit.
  const [edited, setEdited] = useState(false);
  const groupIdRef = useRef(groupId);
  if (groupIdRef.current !== groupId) {
    groupIdRef.current = groupId;
    setEdited(false);
  }
  const lock = useEditLock({
    client: groupLockClient,
    // Only workspace groups lock — personal (non-workspace) groups stay fully
    // editable with no peek/pending, matching the server's workspace gating.
    enabled: Boolean(groupId && canEdit && currentGroup?.workspaceId),
    isDirty: edited,
    resourceId: groupId ?? undefined,
  });
  // Read-only until the lock resolves, so the user can't start typing on a group
  // that turns out to be locked and get bounced mid-edit.
  const editable = canEdit && !lock.lockedByOther && !lock.pending;

  const editor = useGroupProfileStore((s) => s.editor);
  const handleContentChange = useGroupProfileStore((s) => s.handleContentChange);
  const agentBuilderContentUpdate = useGroupProfileStore((s) => s.agentBuilderContentUpdate);
  const setAgentBuilderContent = useGroupProfileStore((s) => s.setAgentBuilderContent);

  // Create save callback that captures latest groupId
  const saveContent = useCallback(
    async (payload: { content: string; editorData: Record<string, any> }) => {
      if (!canEdit) return;
      if (!groupId) return;
      await updateGroup(groupId, {
        content: payload.content,
        editorData: payload.editorData,
      });
    },
    [canEdit, updateGroup, groupId],
  );

  const onContentChange = useCallback(() => {
    if (!editable) return;

    setEdited(true);
    handleContentChange(saveContent);
  }, [editable, handleContentChange, saveContent]);

  // Stabilize editorData object reference to prevent unnecessary re-renders
  const editorData = useMemo(
    () => ({
      content: currentGroup?.content ?? undefined,
      editorData: currentGroup?.editorData,
    }),
    [currentGroup?.content, currentGroup?.editorData],
  );

  // Watch for agent builder content updates and apply them directly to the editor
  useEffect(() => {
    if (!editor || !agentBuilderContentUpdate || !groupId) return;
    if (agentBuilderContentUpdate.entityId !== groupId) return;

    // Directly set the editor content
    editor.setDocument('markdown', agentBuilderContentUpdate.content);

    // Clear the update after processing to prevent re-applying
    setAgentBuilderContent('', '');
  }, [editor, agentBuilderContentUpdate, groupId, setAgentBuilderContent]);

  const openSettings = () => {
    if (!canEdit) return;

    settingsModalRef.current?.close();
    settingsModalRef.current = openGroupAgentSettingsModal();
  };

  const statusTags = (
    <>
      <AutoSaveHint />
      <GroupStatusTag />
      <GroupVersionReviewTag />
      <GroupForkTag />
      <AccessLevelTag
        resourceType={'agentGroup'}
        resourceId={
          hasActiveWorkspace && currentGroup?.visibility !== 'private'
            ? (groupId ?? undefined)
            : undefined
        }
      />
    </>
  );

  const editorCanvas = (
    <>
      <EditingIndicator
        holderId={lock.lockedByOther ? lock.holderId : null}
        pending={canEdit && lock.pending}
      />
      <EditorCanvas
        disabled={!canEdit}
        editable={!lock.lockedByOther && !lock.pending}
        editor={editor}
        editorData={editorData}
        entityId={groupId}
        placeholder={t('group.profile.contentPlaceholder', { ns: 'chat' })}
        onContentChange={onContentChange}
      />
    </>
  );

  if (GROUP_PROFILE_SHOWCASE_LAYOUT)
    return (
      <>
        <Flexbox
          gap={24}
          style={{ cursor: 'default', marginBottom: 24, paddingTop: 24 }}
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <Flexbox horizontal align={'center'} gap={8} wrap={'wrap'}>
            {statusTags}
          </Flexbox>
          <Flexbox horizontal align={'flex-start'} gap={16} justify={'space-between'}>
            <GroupHeader compact />
            <Flexbox horizontal align={'center'} flex={'none'} gap={12}>
              <Button
                data-brand-slot={'group-profile-add-member'}
                disabled={!canEdit}
                icon={brandIcon('group.addMember', UserPlusIcon)}
                shape={'round'}
                size={'large'}
                onClick={() => setShowAddModal(true)}
              >
                {t('group.profile.addMember.title', { ns: 'chat' })}
              </Button>
              <Button
                icon={brandIcon('topic.new', MessageSquarePlusIcon)}
                shape={'round'}
                size={'large'}
                type={'primary'}
                onClick={() => {
                  if (!groupId) return;
                  router.push(urlJoin('/group', groupId));
                }}
              >
                {t('group.profile.enterChat', { ns: 'chat' })}
              </Button>
              <DropdownMenu
                items={[
                  {
                    disabled: !canEdit,
                    icon: <Icon icon={Settings2Icon} />,
                    key: 'advancedSettings',
                    label: t('advancedSettings'),
                    onClick: openSettings,
                  },
                  ...(moreMenuItems.length > 0 ? [{ type: 'divider' as const }] : []),
                  ...(moreMenuItems as any[]),
                ]}
              >
                <ActionIcon
                  icon={brandIcon('action.more', MoreHorizontalIcon)}
                  size={'small'}
                  style={{ color: theme.colorTextSecondary }}
                />
              </DropdownMenu>
            </Flexbox>
          </Flexbox>
          <GroupMembersGrid />
        </Flexbox>
        <Text strong fontSize={14} style={{ marginBottom: 12 }}>
          {t('settingAgent.prompt.title')}
        </Text>
        <div data-brand-slot={'group-profile-prompt'} {...stylex.props(styles.promptFrame)}>
          {editorCanvas}
        </div>
        {groupId && (
          <AddGroupMemberModal
            existingMembers={existingMemberIds}
            groupId={groupId}
            open={showAddModal}
            onCancel={() => setShowAddModal(false)}
            onConfirm={async (agentIds) => {
              await addAgentsToGroup(groupId, agentIds);
              setShowAddModal(false);
            }}
          />
        )}
      </>
    );

  return (
    <>
      <Flexbox
        style={{ cursor: 'default', marginBottom: 12 }}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <Flexbox height={66} width={'100%'}>
          <Flexbox horizontal align={'center'} gap={8} paddingBlock={12}>
            <AutoSaveHint />
            <GroupStatusTag />
            <GroupVersionReviewTag />
            <GroupForkTag />
            <AccessLevelTag
              resourceType={'agentGroup'}
              resourceId={
                hasActiveWorkspace && currentGroup?.visibility !== 'private'
                  ? (groupId ?? undefined)
                  : undefined
              }
            />
          </Flexbox>
        </Flexbox>
        {/* Header: Group Avatar + Title */}
        <GroupHeader />
        {/* Start Conversation Button */}
        <Flexbox
          horizontal
          align={'center'}
          gap={8}
          justify={'flex-start'}
          style={{ marginTop: 16 }}
        >
          <Button
            icon={PlayIcon}
            type={'primary'}
            onClick={() => {
              if (!groupId) return;
              router.push(urlJoin('/group', groupId));
            }}
          >
            {t('startConversation')}
          </Button>
          {moreMenuItems.length > 0 && (
            <DropdownMenu items={moreMenuItems}>
              <ActionIcon
                icon={MoreHorizontalIcon}
                size={'small'}
                style={{ color: theme.colorTextSecondary }}
              />
            </DropdownMenu>
          )}
          <Button
            disabled={!canEdit}
            icon={Settings2Icon}
            size={'small'}
            style={{ color: theme.colorTextSecondary }}
            type={'text'}
            onClick={() => {
              if (!canEdit) return;

              settingsModalRef.current?.close();
              settingsModalRef.current = openGroupAgentSettingsModal();
            }}
          >
            {t('advancedSettings')}
          </Button>
        </Flexbox>
      </Flexbox>
      <Divider style={{ marginBlock: 24 }} />
      {/* Group Content Editor */}
      <EditingIndicator
        holderId={lock.lockedByOther ? lock.holderId : null}
        pending={canEdit && lock.pending}
      />
      <EditorCanvas
        disabled={!canEdit}
        editable={!lock.lockedByOther && !lock.pending}
        editor={editor}
        editorData={editorData}
        entityId={groupId}
        placeholder={t('group.profile.contentPlaceholder', { ns: 'chat' })}
        onContentChange={onContentChange}
      />
    </>
  );
});

export default GroupProfile;
