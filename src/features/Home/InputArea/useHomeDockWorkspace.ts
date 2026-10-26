import { type ComponentType, startTransition, useEffect, useState } from 'react';

export type HomeDockWorkspaceComponent = ComponentType<{
  agentId: string;
  className?: string;
}>;

export const loadHomeDockWorkspace = () =>
  import('@/features/ChatInput/ControlBar/HomeDockWorkspace');

/**
 * ChatInput stays out of the home route's static graph. The dock loads the
 * same workspace cluster the topic bar uses only once a chat send can need it.
 */
export const useHomeDockWorkspace = (enabled: boolean) => {
  const [Workspace, setWorkspace] = useState<HomeDockWorkspaceComponent>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let active = true;
    void loadHomeDockWorkspace()
      .then(({ default: Loaded }) => {
        if (!active) return;
        startTransition(() => setWorkspace(() => Loaded));
      })
      .catch((error) => {
        if (!active) return;
        console.error('[HomeAgentDock] Failed to load workspace controls', error);
        setFailed(true);
      });

    return () => {
      active = false;
    };
  }, [enabled]);

  return { failed, Workspace };
};
