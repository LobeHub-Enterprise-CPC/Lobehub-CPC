/** Scheduled tasks replace the ordinary workspace sidebar with their own list. */
export const isScheduledTasksWorkspace = (pathname: string, search: string) =>
  /\/tasks\/?$/.test(pathname) && new URLSearchParams(search).get('collection') === 'scheduled';
