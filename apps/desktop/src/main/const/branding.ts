import { BRANDING_NAME, CLI_PRIMARY_BIN } from '@lobechat/business-const';

export { BRANDING_NAME, CLI_PRIMARY_BIN };

/** True for any distribution that ships under its own name instead of LobeHub. */
export const isCustomBranding = (BRANDING_NAME as string) !== 'LobeHub';
