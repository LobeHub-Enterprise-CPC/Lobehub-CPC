import { createLogger } from '@/utils/logger';

const logger = createLogger('services:GatewayAccessToken');

/**
 * Extract userId (sub claim) from JWT without verification.
 * The token will be verified server-side; we just need the userId for routing.
 */
export const userIdFromAccessToken = (token: string): string | null => {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.sub || null;
  } catch {
    logger.warn('Failed to extract userId from JWT token');
    return null;
  }
};
