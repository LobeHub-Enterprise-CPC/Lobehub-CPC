import type { AgentState } from '@lobechat/agent-runtime';
import { BRANDING_PROVIDER } from '@lobechat/business-const';
import { TRPCError } from '@trpc/server';
import debug from 'debug';
import { ModelProvider } from 'model-bank';
import {
  isProviderDisableBrowserRequest,
  isProviderFetchOnClient,
} from 'model-bank/modelProviders';

import { AiProviderModel } from '@/database/models/aiProvider';
import type { LobeChatDatabase } from '@/database/type';
import { getServerFetchOnClientOverride } from '@/server/globalConfig/serverFetchOnClient';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { resolveRuntimeProvider } from '@/server/modules/ModelRuntime';
import { GatewayAuthorizationError } from '@/server/services/gatewayAuthorization/wire';

import type { ClientLlmUnavailableReason } from './errors';

const log = debug('lobe-server:agent-runtime:llm-relay:site');

export type LlmExecutionSite =
  | { site: 'server' }
  | {
      /** Channel to dispatch on when the executor listens on another run's; see `AgentRunLlmExecutor`. */
      channelOperationId?: string;
      preferredClientId: string;
      runtimeProvider: string;
      site: 'client';
    }
  | { reason: ClientLlmUnavailableReason; site: 'unavailable' };

export interface ResolveLlmExecutionSiteParams {
  db: LobeChatDatabase;
  provider: string;
  state?: Pick<AgentState, 'host' | 'principal'>;
  userId: string;
  workspaceId?: string;
}

const SERVER: LlmExecutionSite = { site: 'server' };

export interface ResolveProviderRelayParams {
  db: LobeChatDatabase;
  provider: string;
  userId: string;
  workspaceId?: string;
}

/**
 * Whether calls to `provider` must run on the user's device, i.e. be relayed:
 * the relay is on for the user, the provider is not platform-owned, and the
 * shared `fetchOnClient` rule — the one the client store applies, on the
 * user's config with this deployment's override (desktop, `OLLAMA_PROXY_URL`)
 * as the default — sends it to the device. `undefined` keeps it on the server.
 */
const resolveDeviceProvider = async ({
  db,
  provider,
  userId,
  workspaceId,
}: ResolveProviderRelayParams): Promise<{ runtimeProvider: string } | undefined> => {
  // Server-only provider cards cannot relay, regardless of the saved user configuration.
  // Other providers (including hosted providers with a custom endpoint) still need the row.
  if (
    provider === BRANDING_PROVIDER ||
    provider === ModelProvider.LobeHub ||
    isProviderDisableBrowserRequest(provider)
  )
    return;

  const config = await new AiProviderModel(db, userId, workspaceId).getAiProviderById(
    provider,
    KeyVaultsGateKeeper.getUserKeyVaults,
  );
  const fetchOnClient = isProviderFetchOnClient(provider, {
    fetchOnClient: config?.fetchOnClient ?? getServerFetchOnClientOverride(provider),
    keyVaults: config?.keyVaults as { apiKey?: string; baseURL?: string } | undefined,
  });

  log('provider=%s fetchOnClient=%s', provider, fetchOnClient);
  if (!fetchOnClient) return;

  return { runtimeProvider: resolveRuntimeProvider(provider, config?.settings?.sdkType) };
};

/** Request entry: reject a device-only call before allocating any upstream relay runtime. */
export const resolveProviderRelay = async (
  params: ResolveProviderRelayParams,
): Promise<{ runtimeProvider: string } | undefined> => {
  if (await resolveDeviceProvider(params))
    throw new GatewayAuthorizationError('LLM_RELAY_UNSUPPORTED', 501);
  return undefined;
};

/**
 * Where one LLM call of a run executes (T-540 §2.1). The server is the
 * authority — the client only declares that it *can* execute
 * (`state.host.llmExecutor`).
 *
 * - `server`: the default. Also kept when the relay is off for this user, for
 *   platform-owned providers (their credentials never go to a client), and for
 *   shared-agent visitor runs (the creator's provider config is not the
 *   visitor's to run).
 * - `client`: the provider is one only the user's device can reach — it runs
 *   with client requests (`fetchOnClient`) — and the run's client declared it
 *   can execute that provider.
 * - `unavailable`: such a provider, but no client to execute it.
 */
export const resolveLlmExecutionSite = async ({
  db,
  provider,
  state,
  userId,
  workspaceId,
}: ResolveLlmExecutionSiteParams): Promise<LlmExecutionSite> => {
  if (state?.principal?.actor?.shareVisitor) return SERVER;

  const relay = await resolveDeviceProvider({ db, provider, userId, workspaceId });
  if (!relay) return SERVER;

  return { reason: 'relay_unsupported', site: 'unavailable' };
};

export const assertGatewayProviderCapability = async (
  db: LobeChatDatabase,
  userId: string,
  provider: string,
  workspaceId?: string,
) => {
  if (await resolveDeviceProvider({ db, userId, provider, workspaceId }))
    throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: 'LLM_RELAY_UNSUPPORTED' });
};
