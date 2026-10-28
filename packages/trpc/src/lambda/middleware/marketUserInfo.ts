import { type LobeChatDatabase } from '@lobechat/database';
import { TRPCError } from '@trpc/server';

import { UserModel } from '@/database/models/user';
import { type TrustedClientUserInfo } from '@/libs/trusted-client';
import { TrustedClientIdentityError } from '@/libs/trusted-client/errors';
import { resolveTrustedClientIdentity } from '@/libs/trusted-client/resolveIdentity';

import { trpc } from '../init';

interface ContextWithServerDB {
  marketAccessToken?: string;
  serverDB?: LobeChatDatabase;
  userId?: string | null;
  workspaceId?: string | null;
}

interface MarketUserContext {
  marketAccessToken?: string;
  marketUserInfo?: TrustedClientUserInfo;
}

/**
 * The tRPC face of {@link TrustedClientIdentityError}. The message keeps the
 * `MARKET_IDENTITY_UNAVAILABLE:<code>` shape so the client can tell this
 * failure apart from an ordinary Market error and say so, instead of showing an
 * empty list or silently browsing as someone else.
 *
 * Never `UNAUTHORIZED`, even when the user row is gone: that code makes the
 * response carry the "session expired" header the desktop app answers with a
 * re-login, and the session here is fine — it is the Market identity that is
 * not.
 */
export const toMarketIdentityTRPCError = (error: TrustedClientIdentityError) =>
  new TRPCError({ cause: error, code: 'INTERNAL_SERVER_ERROR', message: error.message });

export const resolveMarketUserContext = async (
  ctx: ContextWithServerDB,
): Promise<MarketUserContext> => {
  // If userId or serverDB is not available, skip fetching user info
  if (!ctx.userId || !ctx.serverDB) return { marketUserInfo: undefined };

  let marketUserInfo: TrustedClientUserInfo | undefined;
  try {
    // Identity assembly failures are NOT swallowed: with trusted client enabled
    // they throw, and the request fails rather than reaching Market as a
    // different (or no) principal. `undefined` only means "not applicable".
    marketUserInfo = await resolveTrustedClientIdentity({
      serverDB: ctx.serverDB,
      userId: ctx.userId,
      // Local routing context. Inside a tenant it is dropped from the identity
      // (acting-as-organization is closed there); outside one it is kept.
      workspaceId: ctx.workspaceId ?? undefined,
    });
  } catch (error) {
    if (error instanceof TrustedClientIdentityError) throw toMarketIdentityTRPCError(error);
    throw error;
  }

  if (!marketUserInfo) return { marketUserInfo: undefined };

  try {
    // Fetch market access token from user_settings.market
    const userModel = new UserModel(ctx.serverDB, ctx.userId);
    const userSettings = await userModel.getUserSettings();
    const marketTokenFromDB = (userSettings?.market as any)?.accessToken;

    return {
      // Prioritize database token over cookie token
      marketAccessToken: marketTokenFromDB || ctx.marketAccessToken,
      marketUserInfo,
    };
  } catch {
    // The settings row is optional: the identity above is what Market keys on.
    return { marketAccessToken: ctx.marketAccessToken, marketUserInfo };
  }
};

/**
 * Middleware that fetches user info for Market trusted client authentication
 * This requires serverDatabase middleware to be applied first
 */
export const marketUserInfo = trpc.middleware(async (opts) => {
  const ctx = opts.ctx as ContextWithServerDB;
  const marketContext = await resolveMarketUserContext(ctx);

  return opts.next({ ctx: marketContext });
});
