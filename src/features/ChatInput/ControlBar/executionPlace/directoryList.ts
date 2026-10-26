import type { WorkingDirEntry } from '@lobechat/types';
import { getWorkingDirSourcePath } from '@lobechat/types';

/**
 * The place picker's directory list always includes the current directory, so
 * the check has a row even when that path is not in the device recents yet.
 */
export const ensureSelectedDirectoryListed = (
  entries: WorkingDirEntry[],
  selectedDir?: string,
): WorkingDirEntry[] => {
  if (!selectedDir) return entries;
  if (entries.some((entry) => getWorkingDirSourcePath(entry) === selectedDir)) return entries;
  return [{ path: selectedDir }, ...entries];
};
