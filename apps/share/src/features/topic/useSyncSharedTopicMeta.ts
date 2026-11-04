import { type AgentGroupDetail, type AgentGroupMember } from '@lobechat/types';
import { useEffect } from 'react';

import { useAgentStore } from '@/store/agent';
import { useAgentGroupStore } from '@/store/agentGroup';
import { type SharedTopicData } from '@/types/topic';

export const useSyncSharedTopicMeta = (data: SharedTopicData | undefined) => {
  const dispatchAgentMap = useAgentStore((s) => s.internal_dispatchAgentMap);

  useEffect(() => {
    if (data?.agentId && data.agentMeta) {
      dispatchAgentMap(data.agentId, {
        avatar: data.agentMeta.avatar ?? undefined,
        backgroundColor: data.agentMeta.backgroundColor ?? undefined,
        name: data.agentMeta.name ?? undefined,
        title: data.agentMeta.title ?? undefined,
      });
    }
  }, [data?.agentId, data?.agentMeta, dispatchAgentMap]);

  // Replies from other agents (a direct @Agent answer) carry their own agentId;
  // without their meta the transcript labels them "Untitled Agent".
  useEffect(() => {
    for (const agent of data?.participants ?? []) {
      dispatchAgentMap(agent.id, {
        avatar: agent.avatar ?? undefined,
        backgroundColor: agent.backgroundColor ?? undefined,
        name: agent.name ?? undefined,
        title: agent.title ?? undefined,
      });
    }
  }, [data?.participants, dispatchAgentMap]);

  useEffect(() => {
    if (!data?.groupId || !data.groupMeta) return;

    const members = data.groupMeta.members || [];

    for (const member of members) {
      dispatchAgentMap(member.id, {
        avatar: member.avatar ?? undefined,
        backgroundColor: member.backgroundColor ?? undefined,
        name: member.name ?? undefined,
        title: member.title ?? undefined,
      });
    }

    const groupDetail: AgentGroupDetail = {
      agents: members.map((m) => ({
        avatar: m.avatar,
        backgroundColor: m.backgroundColor,
        id: m.id,
        isSupervisor: false,
        title: m.title,
      })) as AgentGroupMember[],
      avatar: data.groupMeta.avatar,
      backgroundColor: data.groupMeta.backgroundColor,
      createdAt: data.groupMeta.createdAt ? new Date(data.groupMeta.createdAt) : new Date(),
      id: data.groupId,
      title: data.groupMeta.title,
      updatedAt: data.groupMeta.updatedAt ? new Date(data.groupMeta.updatedAt) : new Date(),
      userId: data.groupMeta.userId || '',
    };

    useAgentGroupStore.setState(
      (state) => ({
        activeGroupId: data.groupId!,
        groupMap: {
          ...state.groupMap,
          [data.groupId!]: groupDetail,
        },
      }),
      false,
      'syncSharedGroupMeta',
    );
  }, [data?.groupId, data?.groupMeta, dispatchAgentMap]);
};
