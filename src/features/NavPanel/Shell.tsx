'use client';

import HomeNavPanelPortal from '@/features/HomeSidebar';
import { useActiveLocation } from '@/hooks/useActiveLocation';

import NavPanel from './index';
import { isScheduledTasksWorkspace } from './isScheduledTasksWorkspace';

// The Home portal is owned by the shell, not by the Home route layout: routes
// without a dedicated sidebar (for example /tasks, /agents) resolve to the
// `home` nav key, and on desktop `NavPanel` lives outside `TabHost` while the
// Home layout only mounts inside a home tab — and `Activity` unmounts effects
// for inactive tabs. Registering from the route layout leaves those tabs with
// no `home` entry at all, so the panel is stuck on the loading skeleton.
const NavPanelShell = () => {
  const { pathname, search } = useActiveLocation();
  // A scheduled-task workspace owns the left navigation slot itself. This
  // shared shell runs in both Web and Electron, including tab changes.
  const scheduled = isScheduledTasksWorkspace(pathname, search);
  if (scheduled) return null;
  return (
    <>
      <HomeNavPanelPortal />
      <NavPanel />
    </>
  );
};

export default NavPanelShell;
