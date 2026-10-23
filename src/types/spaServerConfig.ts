import type { TenantContext } from '@lobechat/business-tenant/routing';

import type { IFeatureFlags } from '@/config/featureFlags';
import type { GlobalServerConfig } from '@/types/serverConfig';

export interface AnalyticsConfig {
  clarity?: { projectId: string };
  desktop?: { baseUrl: string; projectId: string };
  google?: { measurementId: string };
  plausible?: { domain: string; scriptBaseUrl: string };
  posthog?: { debug: boolean; host: string; key: string };
  reactScan?: { apiKey: string };
  umami?: { scriptUrl: string; websiteId: string };
  vercel?: { debug: boolean; enabled: boolean };
  xAds?: {
    eventIds?: Record<string, string | undefined>;
    pixelId: string;
    purchaseEventId?: string;
  };
}

export interface SPAClientEnv {
  marketBaseUrl?: string;
  marketSkillInstallBaseUrl?: string;
  pyodideIndexUrl?: string;
  pyodidePipIndexUrl?: string;
  s3FilePath?: string;
}

export type DesktopFlowStatus = 'ready' | 'invalid' | 'expired' | 'unavailable';

export interface AuthSPAServerConfig {
  analyticsConfig: AnalyticsConfig;
  appUrl: string;
  config: GlobalServerConfig;
  desktopFlow?: { status: DesktopFlowStatus };
  enableOIDC: boolean;
  featureFlags: Partial<IFeatureFlags>;
  globalCDN?: boolean;
  rootAccount?: true;
  tenant?: TenantContext;
}

export interface SPAServerConfig {
  analyticsConfig: AnalyticsConfig;
  appUrl?: string;
  clientEnv: SPAClientEnv;
  config: GlobalServerConfig;
  featureFlags: Partial<IFeatureFlags>;
  isMobile: boolean;
  rootAccount?: true;
  tenant?: TenantContext;
}
