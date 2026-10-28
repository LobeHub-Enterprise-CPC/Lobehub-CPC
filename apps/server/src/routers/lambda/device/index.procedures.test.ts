// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { deviceRouter } from '.';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('deviceRouter procedures', () => {
  const procedures = (deviceRouter as any)._def.procedures as Record<string, any>;

  it('exposes exactly the expected procedure paths', () => {
    expect(Object.keys(procedures).sort()).toEqual(expected().map(([name]) => name));
  });

  it.each(expected())('%s is a %s with %i middlewares', (name, type, middlewares) => {
    expect(procedures[name]._def.type).toBe(type);
    expect(procedures[name]._def.middlewares).toHaveLength(middlewares);
  });
});

function expected(): Array<
  [name: string, type: 'mutation' | 'query' | 'subscription', middlewares: number]
> {
  return [
    ['addGitWorktree', 'mutation', 13],
    ['addWorkspaceDeviceWorkingDir', 'mutation', 14],
    ['browseDirectory', 'query', 13],
    ['checkAppUpdate', 'mutation', 13],
    ['checkCapability', 'query', 13],
    ['checkCliUpdate', 'mutation', 13],
    ['checkoutGitBranch', 'mutation', 13],
    ['closeTerminal', 'mutation', 13],
    ['copyAssetForPublish', 'mutation', 16],
    ['copyProjectFiles', 'mutation', 16],
    ['createDirectory', 'mutation', 13],
    ['createProjectDirectory', 'mutation', 16],
    ['createProjectFile', 'mutation', 16],
    ['createTerminalSession', 'mutation', 13],
    ['createTunnel', 'mutation', 13],
    ['deleteGitBranch', 'mutation', 13],
    ['getAgentProfile', 'query', 13],
    ['getAppUpdateState', 'query', 13],
    ['getClaudeCodeQuota', 'mutation', 13],
    ['getCliUpdateState', 'query', 13],
    ['getDeviceActivity', 'query', 13],
    ['getDeviceSystemInfo', 'query', 13],
    ['getGitBranchDiff', 'query', 13],
    ['getGitWorkingTreeFiles', 'query', 13],
    ['getGitWorkingTreePatches', 'query', 13],
    ['getLocalFilePreview', 'query', 15],
    ['getProjectFileIndex', 'query', 13],
    ['getRunningSummary', 'query', 12],
    ['gitAheadBehind', 'query', 13],
    ['gitBranch', 'query', 13],
    ['gitLinkedPullRequest', 'query', 13],
    ['gitPullRequestActivity', 'query', 13],
    ['gitPullRequestDetail', 'query', 13],
    ['gitPullRequestMergeContext', 'query', 13],
    ['gitWorkingTreeStatus', 'query', 13],
    ['installAppUpdate', 'mutation', 13],
    ['listDevices', 'query', 12],
    ['listGitBranches', 'query', 13],
    ['listGitRemoteBranches', 'query', 13],
    ['listGitWorktrees', 'query', 13],
    ['listHeterogeneousAgentModels', 'mutation', 13],
    ['listListeningPorts', 'query', 13],
    ['listProjectDirectory', 'query', 13],
    ['listProjectSkills', 'query', 13],
    ['listTunnels', 'query', 13],
    ['mintWorkspaceConnectToken', 'mutation', 11],
    ['moveProjectFiles', 'mutation', 16],
    ['openTunnel', 'mutation', 13],
    ['pullGitBranch', 'mutation', 13],
    ['pushGitBranch', 'mutation', 13],
    ['readExternalAssetForPublish', 'query', 16],
    ['readTerminal', 'mutation', 13],
    ['register', 'mutation', 13],
    ['registerWorkspaceDevice', 'mutation', 13],
    ['removeDevice', 'mutation', 13],
    ['removeGitWorktree', 'mutation', 13],
    ['removeWorkspaceDevice', 'mutation', 13],
    ['removeWorkspaceDeviceWorkingDir', 'mutation', 14],
    ['renameGitBranch', 'mutation', 13],
    ['renameProjectFile', 'mutation', 16],
    ['resizeTerminal', 'mutation', 13],
    ['restartCli', 'mutation', 13],
    ['revertGitFile', 'mutation', 13],
    ['revokeTunnel', 'mutation', 13],
    ['runGitPullRequestAction', 'mutation', 14],
    ['scanAgents', 'query', 13],
    ['searchProjectFiles', 'query', 13],
    ['setWorkspaceDeviceVisibility', 'mutation', 13],
    ['shareDeviceToWorkspace', 'mutation', 13],
    ['statPath', 'query', 13],
    ['status', 'query', 12],
    ['trashProjectFiles', 'mutation', 16],
    ['updateDevice', 'mutation', 13],
    ['updateDeviceInfo', 'mutation', 13],
    ['updateWorkspaceDevice', 'mutation', 13],
    ['writeProjectFile', 'mutation', 16],
    ['writeTerminal', 'mutation', 13],
  ];
}
