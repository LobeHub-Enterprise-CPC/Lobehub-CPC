import path from 'node:path';

import {
  formatHeterogeneousProviderBindingError,
  getHeterogeneousAgentConfigOrThrow,
  resolveHeterogeneousAgentCommand,
  resolveHeterogeneousProviderBinding,
} from '@lobechat/heterogeneous-agents';
import {
  ChannelAgentClient,
  type PrepareChannelLaunch,
  prepareChannelLaunch,
  type ProbeChannelAgent,
} from '@lobechat/heterogeneous-agents/channel';
import { buildHeteroSpawnArgs, type HeterogeneousProviderConfig } from '@lobechat/types';

import type { App } from '@/core/App';
import { detectHeterogeneousCliCommand } from '@/modules/binaries';

import type { RemoteServerAuth } from './fileStorePort';
import { getHeterogeneousAgentDriver } from './index';
import {
  prepareHostedProviderBinding,
  prepareHostedServerDefaultBinding,
} from './providerBindingHost';
import { getProviderBindingRuntime, getServerDefaultEndpoint } from './providerBindingPort';
import { buildDesktopSpawnEnv } from './spawnEnvironment';

type ChannelDesktop = Pick<App, 'binaryManager' | 'storeManager'>;

async function prepareCommand(
  runtime: Parameters<ProbeChannelAgent>[1],
  provider?: HeterogeneousProviderConfig,
  app?: ChannelDesktop,
) {
  const command = resolveHeterogeneousAgentCommand(runtime, provider?.command);
  const configuredEnv = buildDesktopSpawnEnv({
    agentType: runtime,
    env: provider?.env,
    proxy: app?.storeManager.get('networkProxy'),
  });
  const status =
    command === getHeterogeneousAgentConfigOrThrow(runtime).defaultCommand &&
    !provider?.env?.PATH &&
    app?.binaryManager
      ? await app.binaryManager.detect(command)
      : await detectHeterogeneousCliCommand(runtime, command, configuredEnv);
  if (!status.available)
    throw new Error('Agent CLI is unavailable; check its command and Desktop connection');
  const resolved = !!status.path && !command.includes(path.sep);
  return {
    command: resolved ? status.path : command,
    env: buildDesktopSpawnEnv({
      agentType: runtime,
      env: provider?.env,
      proxy: app?.storeManager.get('networkProxy'),
      searchPath: resolved ? status.resolvedPathEnv : undefined,
    }) as Record<string, string>,
    inheritEnv: false,
  };
}

export const createChannelProbe =
  (app?: ChannelDesktop): ProbeChannelAgent =>
  async (cwd, runtime, provider) => {
    const prepared = await prepareCommand(runtime, provider, app);
    return ChannelAgentClient.probe(
      cwd,
      runtime,
      { ...provider, type: runtime, command: prepared.command, env: prepared.env },
      false,
    );
  };

/** Channel uses the same authenticated provider profiles as standalone Desktop Agents. */
export const createChannelLaunch =
  (auth: RemoteServerAuth, appStoragePath: string, app?: ChannelDesktop): PrepareChannelLaunch =>
  async (input) => {
    const provider = input.provider;
    const command = await prepareCommand(input.runtime ?? 'codex', provider, app);
    if (provider?.authMode !== 'api') return { ...(await prepareChannelLaunch(input)), ...command };
    if (provider.type !== (input.runtime ?? 'codex')) throw new Error('Agent runtime changed');
    if (!provider.apiConfig) throw new Error('Agent API configuration is missing');
    const common = {
      agentType: provider.type,
      appStoragePath,
      args: buildHeteroSpawnArgs(provider) || [],
      driver: getHeterogeneousAgentDriver(provider.type),
      env: provider.env,
      sessionId: input.runId,
    };
    if (provider.apiConfig.source === 'server-default') {
      if (!input.serverDefaultBinding)
        throw new Error('Server model execution authorization is missing');
      const binding = await prepareHostedServerDefaultBinding({
        ...common,
        endpoint: await getServerDefaultEndpoint(auth),
        model: provider.apiConfig.model,
      });
      if (!binding.operationTokenEnvKey) {
        await binding.cleanup();
        throw new Error('Agent does not support server model authorization');
      }
      return {
        ...command,
        bindingKey: binding.bindingKey,
        extraArgs: binding.args,
        env: buildDesktopSpawnEnv({
          agentType: provider.type,
          providerBound: true,
          env: {
            ...command.env,
            ...binding.env,
            [binding.operationTokenEnvKey]: input.serverDefaultBinding.token,
          },
        }) as Record<string, string>,
        cleanup: binding.cleanup,
      };
    }
    const reference = { kind: 'provider' as const, apiConfig: provider.apiConfig };
    const runtime = await getProviderBindingRuntime(auth, reference);
    const result = resolveHeterogeneousProviderBinding({
      agentType: provider.type,
      apiConfig: provider.apiConfig,
      checkCredentials: true,
      enabledModels: runtime.enabledModels,
      providerEnabled: runtime.enabled,
      runtimeConfig: runtime.runtimeConfig,
    });
    if (result.error) throw new Error(formatHeterogeneousProviderBindingError(result.error));
    const binding = await prepareHostedProviderBinding({
      ...common,
      reference,
      resolution: result.resolution,
    });
    return {
      ...command,
      bindingKey: binding.bindingKey,
      extraArgs: binding.args,
      env: buildDesktopSpawnEnv({
        agentType: provider.type,
        providerBound: true,
        env: { ...command.env, ...binding.env },
      }) as Record<string, string>,
      cleanup: binding.cleanup,
    };
  };
