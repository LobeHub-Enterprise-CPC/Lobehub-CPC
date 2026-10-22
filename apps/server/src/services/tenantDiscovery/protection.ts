import { createHmac, hkdfSync } from 'node:crypto';
import { isIP } from 'node:net';

import { z } from 'zod';

import { unavailable } from './errors';

/** Shared mailbox rule for every discovery entry point: trimmed, lower-cased, <=254, email-shaped. */
export const discoveryEmailSchema = z.string().trim().toLowerCase().max(254).email();

/** Maps a raw client address to its rate-limit bucket (IPv6 collapses to /64, mapped IPv4 to IPv4). */
export const ipBucket = (ip: string): string => {
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version === 6 && !ip.includes('%')) {
    try {
      // WHATWG URL canonicalizes compressed and embedded-IPv4 IPv6 spellings.
      const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
      const sides = canonical.split('::');
      const left = sides[0] ? sides[0].split(':') : [];
      const right = sides[1] ? sides[1].split(':') : [];
      const words = (
        sides.length === 2
          ? [
              ...left,
              ...Array.from({ length: 8 - left.length - right.length }, () => '0'),
              ...right,
            ]
          : left
      ).map((word) => parseInt(word, 16));
      if (words.length !== 8 || words.some((word) => !Number.isFinite(word)))
        throw new Error('INVALID_IP');
      if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff)
        return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.');
      return (
        words
          .slice(0, 4)
          .map((word) => word.toString(16))
          .join(':') + '::/64'
      );
    } catch {
      // Malformed/scoped proxy input shares the unknown bucket; never a request-level 503.
    }
  }
  console.warn('TENANT_DISCOVERY_UNKNOWN_IP');
  return 'unknown';
};

export const discoveryIpBucket = (headers: Headers): string =>
  ipBucket(headers.get('x-real-ip')?.trim() ?? '');

const fingerprint = (value: string, info: string) => {
  const secret = process.env.KEY_VAULTS_SECRET;
  if (!secret) throw unavailable();
  const key = hkdfSync('sha256', secret, '', info, 32);
  return createHmac('sha256', Buffer.from(key)).update(value).digest('hex');
};

export const emailFingerprint = (email: string) => fingerprint(email, 'lobehub:tenant-discovery');
export const desktopStateFingerprint = (state: string) =>
  fingerprint(state, 'lobehub:tenant-discovery:desktop');
