import type { LobeToolManifest } from '@lobechat/context-engine';

/**
 * Builtin identifier of the Channel snapshot reader. The manifest is built per
 * run by {@link buildChannelArtifactManifest} and injected through
 * `execAgent({ serverToolManifests })`; execution is served by
 * `toolExecution/serverRuntimes/channelArtifact.ts`, which re-checks the run's
 * `channelContext.artifactRunIds` allowlist instead of trusting the enum.
 */
export const ChannelArtifactIdentifier = 'channel-artifact';

/** Largest page a single `read` returns, in characters. */
export const CHANNEL_ARTIFACT_MAX_PAGE = 20_000;

export interface ChannelArtifactReadArgs {
  length?: number;
  offset?: number;
  runId: string;
}

/**
 * Manifest for the snapshot reader, scoped to the Runs whose artifacts the
 * member may review. Returns `undefined` when there is nothing to read so the
 * caller can leave the tool out entirely.
 */
export const buildChannelArtifactManifest = (
  allowedRunIds: string[],
): LobeToolManifest | undefined => {
  if (!allowedRunIds.length) return undefined;
  const description = `Read an immutable workspace snapshot for review. Includes baseline commit, baseline and final diff/file hashes/content, and observed command/test results. This is source evidence, not member claims. Authorized Run IDs: ${allowedRunIds.join(', ')}. Page through large snapshots using character offset and length.`;
  return {
    api: [
      {
        description,
        name: 'read',
        parameters: {
          additionalProperties: false,
          properties: {
            length: { maximum: CHANNEL_ARTIFACT_MAX_PAGE, minimum: 1, type: 'integer' },
            offset: { minimum: 0, type: 'integer' },
            runId: { enum: allowedRunIds, type: 'string' },
          },
          required: ['runId'],
          type: 'object',
        },
      },
    ],
    identifier: ChannelArtifactIdentifier,
    meta: { title: 'Channel Snapshot' },
    type: 'builtin',
  };
};
