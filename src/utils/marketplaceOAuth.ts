import { z } from 'zod';

/** Public metadata carried by Market's existing installation_details JSON. */
const marketplaceOAuthSchema = z
  .object({
    registration: z.literal('dcr'),
    scopes: z.array(z.string().min(1)).min(1),
    type: z.literal('oauth2'),
    version: z.literal(1),
  })
  .strict();

export type MarketplaceOAuth = z.infer<typeof marketplaceOAuthSchema>;

/** Invalid declarations fail closed instead of installing without authentication. */
export const readMarketplaceOAuth = (details: unknown): MarketplaceOAuth | undefined => {
  if (!details || typeof details !== 'object' || !('mcpAuth' in details)) return;
  return marketplaceOAuthSchema.parse(details.mcpAuth);
};
