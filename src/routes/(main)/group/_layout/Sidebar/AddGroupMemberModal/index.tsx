'use client';

import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import ImperativeModal from '@/components/ImperativeModal';
import { AgentMemberSelection } from '@/features/AgentMemberSelection';
import { groupKeys } from '@/libs/swr/keys';
import { agentService } from '@/services/agent';

import { useAgentSelectionStore } from './store';

export interface AddGroupMemberModalProps {
  existingMembers?: string[];
  groupId: string;
  onCancel: () => void;
  onConfirm: (selectedAgents: string[]) => void | Promise<void>;
  open: boolean;
}

const AddGroupMemberModal = memo<AddGroupMemberModalProps>(
  ({ existingMembers = [], onCancel, onConfirm, open }) => {
    const { t } = useTranslation(['chat', 'common']);

    const selectedAgentIds = useAgentSelectionStore((s) => s.selectedAgentIds);
    const setSelectedAgents = useAgentSelectionStore((s) => s.setSelectedAgents);
    const clearSelection = useAgentSelectionStore((s) => s.clearSelection);

    // Fetch agents from the new API (non-virtual agents only)
    const { data: allAgents = [], isLoading: isLoadingAgents } = useSWR(
      open ? groupKeys.queryAgents() : null,
      () => agentService.queryAgents(),
    );

    // Clear selection when modal closes
    useEffect(() => {
      if (!open) {
        clearSelection();
      }
    }, [open, clearSelection]);

    const [isAdding, setIsAdding] = useState(false);

    const handleConfirm = async () => {
      try {
        setIsAdding(true);
        await onConfirm(selectedAgentIds);
        clearSelection();
      } catch (error) {
        console.error('Failed to add members:', error);
      } finally {
        setIsAdding(false);
      }
    };

    const handleCancel = () => {
      clearSelection();
      onCancel();
    };

    const isConfirmDisabled = selectedAgentIds.length === 0 || isAdding;

    return (
      <ImperativeModal
        allowFullscreen
        okButtonProps={{ disabled: isConfirmDisabled, loading: isAdding }}
        okText={`${t('memberSelection.addMember')} (${selectedAgentIds.length})`}
        open={open}
        title={t('memberSelection.addMember')}
        width={800}
        onCancel={handleCancel}
        onOk={handleConfirm}
      >
        <AgentMemberSelection
          agents={allAgents}
          disabled={isAdding}
          existingMembers={existingMembers}
          isLoading={isLoadingAgents}
          selectedAgentIds={selectedAgentIds}
          onChange={setSelectedAgents}
        />
      </ImperativeModal>
    );
  },
);

export default AddGroupMemberModal;
