import { memo } from 'react';

import ApprovalModeSelector from '../../ControlBar/ApprovalMode';
import { useAgentId } from '../../hooks/useAgentId';
import { useEffectiveAgentMode } from '../../hooks/useEffectiveAgentMode';

/**
 * Approval mode as a composer action, for layouts that place it beside the "+"
 * menu instead of in the ControlBar. Tool approval only exists in the Agent
 * runtime, so nothing renders for a chat-only model.
 */
const ApprovalMode = memo(() => {
  const agentId = useAgentId();
  const { isAgentRuntimeMode } = useEffectiveAgentMode(agentId);

  if (!isAgentRuntimeMode) return null;

  return <ApprovalModeSelector inline />;
});

ApprovalMode.displayName = 'ApprovalModeAction';

export default ApprovalMode;
