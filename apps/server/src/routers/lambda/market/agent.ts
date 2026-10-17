import { currentTenantScope } from '@lobechat/database/tenant';
import debug from 'debug';
import { customAlphabet } from 'nanoid/non-secure';
import { z } from 'zod';

import { withScopedPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import { UserModel } from '@/database/models/user';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { marketSDK, marketUserInfo, serverDatabase } from '@/libs/trpc/lambda/middleware';
import { type TrustedClientUserInfo } from '@/libs/trusted-client';
import { generateTrustedClientToken } from '@/libs/trusted-client';
import { TrustedClientIdentityError } from '@/libs/trusted-client/errors';
import { normalizeLocale } from '@/locales/resources';
import type {
  AgentForkBatchResult,
  AgentForkResponse,
  MarketEditCapabilities,
} from '@/types/discover';

import { actAsInput } from './actingAs';
import { resolveEditRights } from './editRights';
import { isMarketNotFound, mapMarketError } from './marketError';

const MARKET_BASE_URL = process.env.MARKET_BASE_URL || 'https://market.lobehub.com';

interface MarketUserInfo {
  accountId: number;
  sub: string;
}

const log = debug('lambda-router:market:agent');

/**
 * Generate a market identifier (8-character lowercase alphanumeric string)
 * Format: [a-z0-9]{8}
 */
const generateMarketIdentifier = () => {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const generate = customAlphabet(alphabet, 8);
  return generate();
};

interface FetchMarketUserInfoOptions {
  accessToken?: string;
  userInfo?: TrustedClientUserInfo;
}

/**
 * Fetch Market user info using either trustedClientToken or accessToken
 * Returns the Market accountId which is different from LobeChat userId
 *
 * Priority:
 * 1. trustedClientToken (if userInfo is provided and TRUSTED_CLIENT_SECRET is configured)
 * 2. accessToken (if provided, from OIDC flow)
 */
const fetchMarketUserInfo = async (
  options: FetchMarketUserInfoOptions,
): Promise<MarketUserInfo | null> => {
  const { userInfo, accessToken } = options;

  try {
    const userInfoUrl = `${MARKET_BASE_URL}/lobehub-oidc/userinfo`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Try trustedClientToken first (if userInfo is available)
    if (userInfo) {
      const trustedClientToken = generateTrustedClientToken(userInfo);
      if (trustedClientToken) {
        headers['x-lobe-trust-token'] = trustedClientToken;
        log('Using trustedClientToken for user info fetch');
      }
    }

    // Fall back to accessToken if no trustedClientToken
    if (!headers['x-lobe-trust-token'] && accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
      log('Using accessToken for user info fetch');
    }

    // If neither authentication method is available, return null
    if (!headers['x-lobe-trust-token'] && !headers['Authorization']) {
      log('No authentication method available for fetching user info');
      return null;
    }

    const response = await fetch(userInfoUrl, {
      headers,
      method: 'GET',
    });

    if (!response.ok) {
      log('Failed to fetch Market user info: %s %s', response.status, response.statusText);
      return null;
    }

    return (await response.json()) as MarketUserInfo;
  } catch (error) {
    // Not "no user": the caller would read null as "not the owner" and, for a
    // publish, create a second agent under a different identity.
    if (error instanceof TrustedClientIdentityError) throw error;
    log('Error fetching Market user info: %O', error);
    return null;
  }
};

/**
 * Build market-API auth headers from a procedure context.
 * Mirrors the inline pattern used by other market.* procedures.
 */
const buildMarketAuthHeaders = (ctx: {
  marketOidcAccessToken?: string;
  marketUserInfo?: TrustedClientUserInfo;
}): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (ctx.marketUserInfo) {
    const trustedClientToken = generateTrustedClientToken(ctx.marketUserInfo);
    if (trustedClientToken) {
      headers['x-lobe-trust-token'] = trustedClientToken;
    }
  }

  if (!headers['x-lobe-trust-token'] && ctx.marketOidcAccessToken) {
    headers['Authorization'] = `Bearer ${ctx.marketOidcAccessToken}`;
  }

  return headers;
};

const withActingAccountHeader = async <T>(
  marketSDK: unknown,
  actAs: number | undefined,
  operation: () => Promise<T>,
): Promise<T> => {
  const headers = (marketSDK as { headers?: Record<string, string> }).headers;
  if (actAs === undefined || !headers) return operation();

  const previous = headers['x-lobe-owner-account-id'];
  headers['x-lobe-owner-account-id'] = String(actAs);

  try {
    return await operation();
  } finally {
    if (previous === undefined) {
      delete headers['x-lobe-owner-account-id'];
    } else {
      headers['x-lobe-owner-account-id'] = previous;
    }
  }
};

interface ForkAgentItemInput {
  /**
   * When present, fork is attributed to the given Market organization account.
   * Forwarded as `X-Lobe-Owner-Account-Id` so the Market resolves writes to the
   * organization instead of the calling user. The actor must be a member of the
   * target org (enforced server-side by `resolveActingAccount`).
   */
  actAs?: number;
  identifier: string;
  name?: string;
  sourceIdentifier: string;
  status?: 'published' | 'unpublished' | 'archived' | 'deprecated';
  versionNumber?: number;
  visibility?: 'public' | 'private' | 'internal';
}

const forkOneAgent = async (
  item: ForkAgentItemInput,
  baseHeaders: Record<string, string>,
): Promise<AgentForkBatchResult> => {
  try {
    const forkUrl = `${MARKET_BASE_URL}/api/v1/agents/${item.sourceIdentifier}/fork`;
    // Clone so per-item actAs doesn't leak across the batch.
    const headers = { ...baseHeaders };
    if (item.actAs !== undefined) {
      headers['x-lobe-owner-account-id'] = String(item.actAs);
    }
    const response = await fetch(forkUrl, {
      body: JSON.stringify({
        identifier: item.identifier,
        name: item.name,
        status: item.status,
        versionNumber: item.versionNumber,
        visibility: item.visibility,
      }),
      headers,
      method: 'POST',
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(
        'Fork agent failed (source=%s): %s %s - %s',
        item.sourceIdentifier,
        response.status,
        response.statusText,
        errorText,
      );
      return {
        error: {
          code: `HTTP_${response.status}`,
          message: errorText || response.statusText || 'Failed to fork agent',
        },
        sourceIdentifier: item.sourceIdentifier,
        success: false,
      };
    }

    const data = (await response.json()) as AgentForkResponse;
    log('Fork agent success (source=%s)', item.sourceIdentifier);
    return { data, sourceIdentifier: item.sourceIdentifier, success: true };
  } catch (error) {
    log('Error forking agent (source=%s): %O', item.sourceIdentifier, error);
    return {
      error: {
        code: 'FORK_FAILED',
        message: error instanceof Error ? error.message : 'Failed to fork agent',
      },
      sourceIdentifier: item.sourceIdentifier,
      success: false,
    };
  }
};

const forkAgentItemSchema = z.object({
  /**
   * Optional Market organization account id to attribute the fork to. Triggers
   * `X-Lobe-Owner-Account-Id` on the fork request. Caller is responsible for
   * resolving the organization account id before passing this field.
   */
  actAs: actAsInput,
  identifier: z.string(),
  name: z.string().optional(),
  sourceIdentifier: z.string(),
  status: z.enum(['published', 'unpublished', 'archived', 'deprecated']).optional(),
  versionNumber: z.number().optional(),
  visibility: z.enum(['public', 'private', 'internal']).optional(),
});

// Authenticated procedure for agent management
// Requires user to be logged in and has MarketSDK initialized
// Also fetches user's market accessToken from database for OIDC authentication
const agentProcedure = authedProcedure
  .use(serverDatabase)
  .use(marketUserInfo)
  .use(marketSDK)
  .use(async ({ ctx, next }) => {
    const userModel = new UserModel(ctx.serverDB, ctx.userId);

    // Get user's market accessToken from database (stored by MarketAuthProvider after OIDC login)
    let marketOidcAccessToken: string | undefined;
    try {
      const userState = await userModel.getUserState(async () => ({}));
      marketOidcAccessToken = userState.settings?.market?.accessToken;
      log('marketOidcAccessToken from DB exists=%s', !!marketOidcAccessToken);
    } catch (error) {
      log('Failed to get marketOidcAccessToken from DB: %O', error);
    }

    return next({
      ctx: {
        marketOidcAccessToken,
      },
    });
  });
const agentWriteProcedure = agentProcedure.use(withScopedPermission('agent:create'));

// Schema definitions
const createAgentSchema = z.object({
  actAs: actAsInput,
  homepage: z.string().optional(),
  identifier: z.string(),
  isFeatured: z.boolean().optional(),
  name: z.string(),
  status: z.enum(['published', 'unpublished', 'archived', 'deprecated']).optional(),
  tokenUsage: z.number().optional(),
  visibility: z.enum(['public', 'private', 'internal']).optional(),
});

const createAgentVersionSchema = z.object({
  actAs: actAsInput,
  a2aProtocolVersion: z.string().optional(),
  avatar: z.string().optional(),
  category: z.string().optional(),
  changelog: z.string().optional(),
  config: z.record(z.string(), z.any()).optional(),
  defaultInputModes: z.array(z.string()).optional(),
  defaultOutputModes: z.array(z.string()).optional(),
  description: z.string().optional(),
  documentationUrl: z.string().optional(),
  extensions: z.array(z.record(z.string(), z.any())).optional(),
  hasPushNotifications: z.boolean().optional(),
  hasStateTransitionHistory: z.boolean().optional(),
  hasStreaming: z.boolean().optional(),
  identifier: z.string(),
  interfaces: z.array(z.record(z.string(), z.any())).optional(),
  name: z.string().optional(),
  preferredTransport: z.string().optional(),
  providerId: z.number().optional(),
  securityRequirements: z.array(z.record(z.string(), z.any())).optional(),
  securitySchemes: z.record(z.string(), z.any()).optional(),
  setAsCurrent: z.boolean().optional(),
  summary: z.string().optional(),
  supportsAuthenticatedExtendedCard: z.boolean().optional(),
  tokenUsage: z.number().optional(),
  url: z.string().optional(),
});

const paginationSchema = z.object({
  page: z.number().optional(),
  pageSize: z.number().optional(),
});

// Schema for the unified publish/create flow
const publishOrCreateSchema = z.object({
  actAs: actAsInput,
  // Version data
  avatar: z.string().optional(),

  category: z.string().optional(),

  changelog: z.string().optional(),

  config: z.record(z.string(), z.any()).optional(),

  description: z.string().optional(),

  editorData: z.record(z.string(), z.any()).optional(),

  // Agent basic info
  identifier: z.string().nullish(),
  // Optional - if not provided or not owned, will create new (allow null or undefined)
  name: z.string(),
  tags: z.array(z.string()).optional(),
  tokenUsage: z.number().optional(),
});

export const agentRouter = router({
  /**
   * Check if current user owns the specified agent
   * Returns ownership status and original agent info for fork scenario
   */
  checkOwnership: agentProcedure
    .input(z.object({ identifier: z.string() }))
    .query(async ({ input, ctx }) => {
      log('checkOwnership input: %O', input);

      try {
        // Get agent detail
        const agentDetail = await ctx.marketSDK.agents.getAgentDetail(input.identifier);

        if (!agentDetail) {
          return {
            exists: false,
            isOwner: false,
            originalAgent: null,
          };
        }

        // Get Market user info to get accountId
        // Support both trustedClientToken and OIDC accessToken authentication
        const userInfo = ctx.marketUserInfo as TrustedClientUserInfo | undefined;
        const accessToken = (ctx as { marketOidcAccessToken?: string }).marketOidcAccessToken;
        const ownerId = agentDetail.ownerId;

        // In a tenant Market answers "may this requester edit it" itself, so the
        // requester's account is only needed for the single-tenant comparison.
        let currentAccountId: number | null = null;
        if (!currentTenantScope()) {
          const marketUserInfoResult = await fetchMarketUserInfo({ accessToken, userInfo });
          currentAccountId = marketUserInfoResult?.accountId ?? null;
        }

        const { canEdit: isOwner } = resolveEditRights(
          agentDetail as MarketEditCapabilities,
          () => currentAccountId !== null && `${ownerId}` === `${currentAccountId}`,
        );

        log(
          'checkOwnership result: isOwner=%s, currentAccountId=%s, ownerId=%s',
          isOwner,
          currentAccountId,
          ownerId,
        );

        return {
          exists: true,
          isOwner,
          originalAgent: isOwner
            ? null
            : {
                author: agentDetail.author,
                avatar: agentDetail.avatar,
                identifier: agentDetail.identifier,
                name: agentDetail.name,
              },
        };
      } catch (error) {
        log('Error checking ownership: %O', error);
        // Only "not in this scope" means the agent does not exist. A refusal
        // (403), a missing credential (401) or an instance that is not ready (503)
        // says nothing about it, and reading it as "does not exist" would send the
        // caller on to publish a second agent.
        if (isMarketNotFound(error)) {
          return {
            exists: false,
            isOwner: false,
            originalAgent: null,
          };
        }
        throw mapMarketError(error, 'Failed to check agent ownership', { exposeMessage: true });
      }
    }),

  /**
   * Create a new agent in the marketplace
   * POST /market/agent/create
   */
  createAgent: agentWriteProcedure.input(createAgentSchema).mutation(async ({ input, ctx }) => {
    log('createAgent input: %O', input);

    try {
      const { actAs, ...agentData } = input;
      const response = await withActingAccountHeader(ctx.marketSDK, actAs, () =>
        ctx.marketSDK.agents.createAgent(agentData),
      );
      return response;
    } catch (error) {
      log('Error creating agent: %O', error);
      throw mapMarketError(error, 'Failed to create agent', { exposeMessage: true });
    }
  }),

  /**
   * Create a new version for an existing agent
   * POST /market/agent/versions/create
   */
  createAgentVersion: agentWriteProcedure
    .input(createAgentVersionSchema)
    .mutation(async ({ input, ctx }) => {
      log('createAgentVersion input: %O', input);

      try {
        const { actAs, ...versionData } = input;
        const response = await withActingAccountHeader(ctx.marketSDK, actAs, () =>
          ctx.marketSDK.agents.createAgentVersion(versionData),
        );
        return response;
      } catch (error) {
        log('Error creating agent version: %O', error);
        throw mapMarketError(error, 'Failed to create agent version', { exposeMessage: true });
      }
    }),

  /**
   * Deprecate an agent (permanently hide, cannot be republished)
   * POST /market/agent/:identifier/deprecate
   */
  deprecateAgent: agentWriteProcedure
    .input(z.object({ identifier: z.string() }))
    .mutation(async ({ input, ctx }) => {
      log('deprecateAgent input: %O', input);

      try {
        const response = await ctx.marketSDK.agents.deprecate(input.identifier);
        return response ?? { success: true };
      } catch (error) {
        log('Error deprecating agent: %O', error);
        throw mapMarketError(error, 'Failed to deprecate agent', { exposeMessage: true });
      }
    }),

  /**
   * Fork one or more agents in a single batch.
   * POST /market/agent/fork (batch)
   *
   * Best-effort: single-item failures are returned in-line as
   * `{ success: false, error }` and do not abort the rest of the batch.
   */
  forkAgent: agentWriteProcedure
    .input(z.object({ items: z.array(forkAgentItemSchema).min(1) }))
    .mutation(async ({ input, ctx }) => {
      log('forkAgent batch size: %d', input.items.length);

      const headers = buildMarketAuthHeaders(ctx);

      return Promise.all(input.items.map((item) => forkOneAgent(item, headers)));
    }),

  /**
   * Get agent detail by identifier
   * GET /market/agent/:identifier
   */
  getAgentDetail: agentProcedure
    .input(z.object({ identifier: z.string() }))
    .query(async ({ input, ctx }) => {
      log('getAgentDetail input: %O', input);

      try {
        const response = await ctx.marketSDK.agents.getAgentDetail(input.identifier);
        return response;
      } catch (error) {
        log('Error getting agent detail: %O', error);
        throw mapMarketError(error, 'Failed to get agent detail', { exposeMessage: true });
      }
    }),

  /**
   * Get the full curated onboarding agent catalog for the marketplace picker.
   * Proxies to GET /api/v1/agents/onboarding-full with trust-token authentication.
   * Response is keyed by MarketplaceCategory slug.
   */
  getOnboardingFull: agentProcedure
    .input(z.object({ locale: z.string().optional() }).optional().default({}))
    .query(async ({ input, ctx }) => {
      const url = new URL('/api/v1/agents/onboarding-full', MARKET_BASE_URL);
      url.searchParams.set('_ts', String(Date.now()));
      url.searchParams.set('locale', normalizeLocale(input.locale));

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      const userInfo = ctx.marketUserInfo as TrustedClientUserInfo | undefined;
      const accessToken = (ctx as { marketOidcAccessToken?: string }).marketOidcAccessToken;

      if (userInfo) {
        const trustedClientToken = generateTrustedClientToken(userInfo);
        if (trustedClientToken) {
          headers['x-lobe-trust-token'] = trustedClientToken;
        }
      }

      if (!headers['x-lobe-trust-token'] && accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }

      try {
        const response = await fetch(url, { headers, method: 'GET' });

        if (!response.ok) {
          const errorText = await response.text();
          log(
            'Get onboarding full failed: %s %s - %s',
            response.status,
            response.statusText,
            errorText,
          );
          throw new Error(`Failed to get onboarding full: ${response.statusText}`);
        }

        return (await response.json()) as Record<string, unknown[]>;
      } catch (error) {
        log('Error getting onboarding full: %O', error);
        throw mapMarketError(error, 'Failed to get onboarding full', { exposeMessage: true });
      }
    }),

  /**
   * Get the fork source of an agent
   * GET /market/agent/:identifier/fork-source
   */
  getAgentForkSource: agentProcedure
    .input(z.object({ identifier: z.string() }))
    .query(async ({ input, ctx }) => {
      log('getAgentForkSource input: %O', input);

      try {
        const forkSourceUrl = `${MARKET_BASE_URL}/api/v1/agents/${input.identifier}/fork-source`;

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        const userInfo = ctx.marketUserInfo as TrustedClientUserInfo | undefined;
        const accessToken = (ctx as { marketOidcAccessToken?: string }).marketOidcAccessToken;

        if (userInfo) {
          const trustedClientToken = generateTrustedClientToken(userInfo);
          if (trustedClientToken) {
            headers['x-lobe-trust-token'] = trustedClientToken;
          }
        }

        if (!headers['x-lobe-trust-token'] && accessToken) {
          headers['Authorization'] = `Bearer ${accessToken}`;
        }

        const response = await fetch(forkSourceUrl, {
          headers,
          method: 'GET',
        });

        if (!response.ok) {
          const errorText = await response.text();
          log(
            'Get agent fork source failed: %s %s - %s',
            response.status,
            response.statusText,
            errorText,
          );
          throw new Error(`Failed to get agent fork source: ${response.statusText}`);
        }

        const result = await response.json();
        return result;
      } catch (error) {
        log('Error getting agent fork source: %O', error);
        throw mapMarketError(error, 'Failed to get agent fork source', { exposeMessage: true });
      }
    }),

  /**
   * Get all forks of an agent
   * GET /market/agent/:identifier/forks
   */
  getAgentForks: agentProcedure
    .input(z.object({ identifier: z.string() }))
    .query(async ({ input, ctx }) => {
      log('getAgentForks input: %O', input);

      try {
        const forksUrl = `${MARKET_BASE_URL}/api/v1/agents/${input.identifier}/forks`;

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        const userInfo = ctx.marketUserInfo as TrustedClientUserInfo | undefined;
        const accessToken = (ctx as { marketOidcAccessToken?: string }).marketOidcAccessToken;

        if (userInfo) {
          const trustedClientToken = generateTrustedClientToken(userInfo);
          if (trustedClientToken) {
            headers['x-lobe-trust-token'] = trustedClientToken;
          }
        }

        if (!headers['x-lobe-trust-token'] && accessToken) {
          headers['Authorization'] = `Bearer ${accessToken}`;
        }

        const response = await fetch(forksUrl, {
          headers,
          method: 'GET',
        });

        if (!response.ok) {
          const errorText = await response.text();
          log(
            'Get agent forks failed: %s %s - %s',
            response.status,
            response.statusText,
            errorText,
          );
          throw new Error(`Failed to get agent forks: ${response.statusText}`);
        }

        const result = await response.json();
        return result;
      } catch (error) {
        log('Error getting agent forks: %O', error);
        throw mapMarketError(error, 'Failed to get agent forks', { exposeMessage: true });
      }
    }),

  /**
   * Get own agents (requires authentication)
   * GET /market/agent/own
   */
  getOwnAgents: agentProcedure.input(paginationSchema.optional()).query(async ({ input, ctx }) => {
    log('getOwnAgents input: %O', input);

    try {
      const response = await ctx.marketSDK.agents.getOwnAgents({
        page: input?.page,
        pageSize: input?.pageSize,
      });
      return response;
    } catch (error) {
      log('Error getting own agents: %O', error);
      throw mapMarketError(error, 'Failed to get own agents', { exposeMessage: true });
    }
  }),

  /**
   * Publish an agent (make it visible in marketplace)
   * POST /market/agent/:identifier/publish
   */
  publishAgent: agentWriteProcedure
    .input(z.object({ identifier: z.string() }))
    .mutation(async ({ input, ctx }) => {
      log('publishAgent input: %O', input);

      try {
        const response = await ctx.marketSDK.agents.publish(input.identifier);
        return response ?? { success: true };
      } catch (error) {
        log('Error publishing agent: %O', error);
        throw mapMarketError(error, 'Failed to publish agent', { exposeMessage: true });
      }
    }),

  /**
   * Unified publish or create agent flow
   * This procedure handles the complete publish logic:
   * 1. Check if identifier exists and if current user is owner
   * 2. If not owner or no identifier, create new agent
   * 3. Create new version for the agent
   *
   * Returns: { identifier, isNewAgent, success }
   */
  publishOrCreate: agentWriteProcedure
    .input(publishOrCreateSchema)
    .mutation(async ({ input, ctx }) => {
      log('publishOrCreate input: %O', input);

      const { actAs, identifier: inputIdentifier, name, ...versionData } = input;
      let finalIdentifier = inputIdentifier;
      let isNewAgent = false;

      try {
        // Step 1: Check ownership if identifier is provided
        if (inputIdentifier) {
          try {
            const agentDetail = await ctx.marketSDK.agents.getAgentDetail(inputIdentifier);
            log('Agent detail for ownership check: ownerId=%s', agentDetail?.ownerId);

            // Get Market user info to get accountId (Market's user ID)
            // Support both trustedClientToken and OIDC accessToken authentication
            const userInfo = ctx.marketUserInfo as TrustedClientUserInfo | undefined;
            const accessToken = (ctx as { marketOidcAccessToken?: string }).marketOidcAccessToken;
            let currentAccountId: number | null = null;

            // In a tenant Market says whether this requester may add a version.
            if (!currentTenantScope()) {
              const marketUserInfoResult = await fetchMarketUserInfo({ accessToken, userInfo });
              currentAccountId = marketUserInfoResult?.accountId ?? null;
              log('Market user info: accountId=%s', currentAccountId);
            }

            const ownerId = agentDetail?.ownerId;

            log('Ownership check: currentAccountId=%s, ownerId=%s', currentAccountId, ownerId);

            const actingAccountId = actAs ?? currentAccountId;

            const { canEdit } = resolveEditRights(
              agentDetail as MarketEditCapabilities | undefined,
              () => !!actingAccountId && `${ownerId}` === `${actingAccountId}`,
            );

            if (!canEdit) {
              // Not the owner, need to create a new agent
              log('User is not owner, will create new agent');
              finalIdentifier = undefined;
              isNewAgent = true;
            }
          } catch (detailError) {
            // Only an agent that is not in this scope becomes a new one. A refusal,
            // a missing credential or an instance that is not ready says nothing
            // about whether it exists, and publishing a second agent over it
            // would answer the wrong question.
            if (!isMarketNotFound(detailError)) throw detailError;

            log('Agent not found, will create new: %O', detailError);
            finalIdentifier = undefined;
            isNewAgent = true;
          }
        } else {
          isNewAgent = true;
        }

        // Step 2: Create new agent if needed
        if (!finalIdentifier) {
          // Generate a unique 8-character identifier
          finalIdentifier = generateMarketIdentifier();
          isNewAgent = true;

          log('Creating new agent with identifier: %s', finalIdentifier);

          await withActingAccountHeader(ctx.marketSDK, actAs, () =>
            ctx.marketSDK.agents.createAgent({
              identifier: finalIdentifier!,
              name,
            }),
          );
        }

        // Step 3: Create version for the agent
        log('Creating version for agent: %s', finalIdentifier);

        await withActingAccountHeader(ctx.marketSDK, actAs, () =>
          ctx.marketSDK.agents.createAgentVersion({
            ...versionData,
            identifier: finalIdentifier!,
            name,
          }),
        );

        return {
          identifier: finalIdentifier,
          isNewAgent,
          success: true,
        };
      } catch (error) {
        log('Error in publishOrCreate: %O', error);
        throw mapMarketError(error, 'Failed to publish agent', { exposeMessage: true });
      }
    }),

  /**
   * Unpublish an agent (hide from marketplace, can be republished)
   * POST /market/agent/:identifier/unpublish
   */
  unpublishAgent: agentWriteProcedure
    .input(z.object({ identifier: z.string() }))
    .mutation(async ({ input, ctx }) => {
      log('unpublishAgent input: %O', input);

      try {
        const response = await ctx.marketSDK.agents.unpublish(input.identifier);
        return response ?? { success: true };
      } catch (error) {
        log('Error unpublishing agent: %O', error);
        throw mapMarketError(error, 'Failed to unpublish agent', { exposeMessage: true });
      }
    }),
});

export type AgentRouter = typeof agentRouter;
