import { memo } from 'react';

import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';

import ExecutionDeviceSwitcher from '../../ControlBar/DeviceSwitcher';
import { ExecutionPlacePicker } from '../../ControlBar/executionPlace/ExecutionPlacePicker';
import { useAgentPlacePicker } from '../../ControlBar/executionPlace/useAgentPlacePicker';
import { useAgentId } from '../../hooks/useAgentId';
import { useChatInputResourceAccess } from '../../hooks/useChatInputResourceAccess';
import { useEffectiveAgentMode } from '../../hooks/useEffectiveAgentMode';

/**
 * Where the run executes, as a composer action, for layouts that place it beside
 * the "+" menu instead of in the ControlBar under the input. Directories stay in
 * the bar. A heterogeneous agent keeps its whole workspace cluster there.
 */
const ExecutionDevice = memo(() => {
  const agentId = useAgentId();
  const { isAgentRuntimeMode } = useEffectiveAgentMode(agentId);
  const { canConfigureResource } = useChatInputResourceAccess();
  const { enabled: placePickerActive } = useAgentPlacePicker(agentId);
  const isHeterogeneous = useAgentStore((s) =>
    agentByIdSelectors.isAgentHeterogeneousById(agentId)(s),
  );

  if (!isAgentRuntimeMode || isHeterogeneous) return null;

  if (!placePickerActive) return <ExecutionDeviceSwitcher agentId={agentId} />;

  return <ExecutionPlacePicker showLabel agentId={agentId} allowDirectory={canConfigureResource} />;
});

ExecutionDevice.displayName = 'ExecutionDeviceAction';

export default ExecutionDevice;
