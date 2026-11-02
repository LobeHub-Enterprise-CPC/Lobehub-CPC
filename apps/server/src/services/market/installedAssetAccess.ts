import { type LobeChatDatabase } from '@lobechat/database';
import { currentTenantScope } from '@lobechat/database/tenant';
import { type AssetAccessCheckItem } from '@lobehub/market-types';
import debug from 'debug';

import { AgentSkillModel } from '@/database/models/agentSkill';
import { ConnectorModel } from '@/database/models/connector';
import type { PluginModel } from '@/database/models/plugin';

import { type MarketService } from './index';

const log = debug('lobe-server:market:asset-access');

/** How long one member's answer is reused across turns (spec: per user, 60 seconds). */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 2000;
/** Market's `access/check` contract: identifiers of 1–255 characters, at most 500 items per call. */
const IDENTIFIER_MAX_LENGTH = 255;
const CHECK_BATCH_SIZE = 500;

interface CacheEntry {
  expiresAt: number;
  revoked: string[];
}
const cache = new Map<string, CacheEntry>();

type AssetAccessMarket = Pick<MarketService, 'checkAssetAccess' | 'getSkillDownloadUrl'>;

export interface InstalledMarketAssetsDeps {
  db: LobeChatDatabase;
  pluginModel: Pick<PluginModel, 'query'>;
  userId: string;
  workspaceId?: string;
}

/**
 * Installed tools that came from this tenant's Market catalogue. A skill counts only when it was
 * downloaded from Market (`source = 'market'` also covers GitHub and URL imports); a plugin counts
 * when it is a catalogue install rather than a custom one, and so does every Market connector,
 * including an agent's copy that outlives the plugin install.
 */
const collectInstalledMarketAssets = async (
  { db, pluginModel, userId, workspaceId }: InstalledMarketAssetsDeps,
  skillDownloadUrl: () => Promise<(identifier: string) => string>,
): Promise<AssetAccessCheckItem[]> => {
  const [skills, plugins, connectors] = await Promise.all([
    new AgentSkillModel(db, userId, workspaceId).listBySource('market'),
    pluginModel.query(),
    new ConnectorModel(db, userId, workspaceId).listMarketplaceIdentifiers(),
  ]);
  const pluginIds = new Set([
    ...plugins.filter((plugin) => plugin.type === 'plugin').map((plugin) => plugin.identifier),
    ...connectors,
  ]);
  if (skills.total === 0 && pluginIds.size === 0) return [];

  const downloadUrl = await skillDownloadUrl();
  const items: AssetAccessCheckItem[] = [];
  for (const skill of skills.data) {
    if (skill.manifest?.sourceUrl === downloadUrl(skill.identifier))
      items.push({ identifier: skill.identifier, type: 'skill' });
  }
  for (const identifier of pluginIds) items.push({ identifier, type: 'plugin' });
  // An identifier Market could never hold is not a catalogue asset; sending it would make Market
  // reject the whole check and leave every revoked asset in use.
  return items.filter(
    ({ identifier }) => identifier.length > 0 && identifier.length <= IDENTIFIER_MAX_LENGTH,
  );
};

/** One check per {@link CHECK_BATCH_SIZE} items; the answers are merged. */
const checkInBatches = async (
  marketService: AssetAccessMarket,
  items: AssetAccessCheckItem[],
): Promise<AssetAccessCheckItem[]> => {
  const batches: AssetAccessCheckItem[][] = [];
  for (let start = 0; start < items.length; start += CHECK_BATCH_SIZE)
    batches.push(items.slice(start, start + CHECK_BATCH_SIZE));
  const answers = await Promise.all(batches.map((batch) => marketService.checkAssetAccess(batch)));
  return answers.flat();
};

/**
 * Identifiers of installed Market tools the member may no longer use (spec §8): they are not
 * injected into a run and show as disabled by the enterprise. Only tenant Markets have availability
 * scopes. A failed check keeps the tools (Market itself still refuses hidden downloads and cloud
 * calls), so a Market outage does not strip every installed skill from running conversations.
 */
export const resolveRevokedMarketAssets = async (
  input: InstalledMarketAssetsDeps & {
    /** Built only when the member has installed Market tools. */
    getMarketService: () => Promise<AssetAccessMarket>;
  },
): Promise<string[]> => {
  const tenantId = currentTenantScope()?.tenantId;
  if (!tenantId) return [];
  let marketService: AssetAccessMarket | undefined;
  let items: AssetAccessCheckItem[];
  try {
    items = await collectInstalledMarketAssets(input, async () => {
      marketService = await input.getMarketService();
      return (identifier) => marketService!.getSkillDownloadUrl(identifier);
    });
  } catch (error) {
    log('installed Market tools could not be listed, keeping them: %O', error);
    return [];
  }
  if (items.length === 0 || !marketService) return [];

  const key = JSON.stringify([
    tenantId,
    input.userId,
    input.workspaceId ?? null,
    items.map((item) => `${item.type}:${item.identifier}`).sort(),
  ]);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.revoked;

  let usable: AssetAccessCheckItem[];
  try {
    usable = await checkInBatches(marketService, items);
  } catch (error) {
    log('asset access check failed, keeping installed tools: %O', error);
    return [];
  }
  const allowed = new Set(usable.map((item) => `${item.type}:${item.identifier}`));
  const revoked = [
    ...new Set(
      items
        .filter((item) => !allowed.has(`${item.type}:${item.identifier}`))
        .map((item) => item.identifier),
    ),
  ];
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, revoked });
  return revoked;
};
