/** Global Tasks is the scheduled workspace; scoped agent/project lists retain their tabs. */
export const isScheduledTasksWorkspace = (pathname: string, search: string) =>
  /\/tasks\/?$/.test(pathname) &&
  (!/\/(?:agent|project)\/[^/]+\/tasks\/?$/.test(pathname) ||
    new URLSearchParams(search).get('collection') === 'scheduled');
