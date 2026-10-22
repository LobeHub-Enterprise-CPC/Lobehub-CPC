'use client';

import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import ImperativeModal from '@/components/ImperativeModal';
import { AgentMemberSelection } from '@/features/AgentMemberSelection';

import { selectAddableAgents } from './selectAddableAgents';
import { useAgentSelectionStore } from './store';
import { useAddableGroupMembers } from './useAddableGroupMembers';

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

    const { allAgents, isLoading: isLoadingAgents } = useAddableGroupMembers(existingMembers);
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
          agents={selectAddableAgents(allAgents, [])}
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
