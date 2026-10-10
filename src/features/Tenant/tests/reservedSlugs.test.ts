import { describe, expect, it } from 'vitest';

import { isRegistrableSlug, isReservedSlug, RESERVED_SLUGS } from '../reservedSlugs';

describe('reserved slugs', () => {
  it('reserves the tenant prefix itself', () => {
    // Without this, `/t/t/...` and a workspace literally named `t` both become
    // ambiguous with the prefix.
    expect(isReservedSlug('t')).toBe(true);
  });

  it('reserves every workspace-mirrored segment', () => {
    for (const segment of [
      'agent',
      'community',
      'eval',
      'group',
      'image',
      'memory',
      'page',
      'project',
      'resource',
      'settings',
      'task',
      'video',
    ]) {
      expect(isReservedSlug(segment)).toBe(true);
    }
  });

  it('reserves the personal-only surfaces', () => {
    for (const segment of [
      'apps',
      'invite',
      'onboarding',
      'me',
      'share',
      'devtools',
      'desktop-onboarding',
    ]) {
      expect(isReservedSlug(segment)).toBe(true);
    }
  });

  it('reserves auth and top-level routes that a slug would shadow', () => {
    for (const segment of ['signin', 'signup', 'oauth', 'oidc', 'verify', 'downloads', 'profile']) {
      expect(isReservedSlug(segment)).toBe(true);
    }
  });

  it('reserves the words Console and Admin keep for their own routes', () => {
    // Console registers slugs; if it accepts one that Admin or LobeHub needs
    // for a route, that tenant is unreachable in one of the apps (spec A10).
    for (const segment of [
      'admin',
      'api',
      'applications',
      'auth',
      'bootstrap',
      'console',
      'login',
      'logout',
      'register',
      'tenants',
      'users',
    ]) {
      expect(isReservedSlug(segment)).toBe(true);
    }
  });

  it('compares case-insensitively', () => {
    expect(isReservedSlug('Agent')).toBe(true);
  });

  it('allows an ordinary company slug', () => {
    expect(isRegistrableSlug('acme')).toBe(true);
    expect(isRegistrableSlug('acme-corp')).toBe(true);
  });

  it('rejects reserved and malformed slugs at registration', () => {
    expect(isRegistrableSlug('agent')).toBe(false);
    expect(isRegistrableSlug('Acme')).toBe(false);
    expect(isRegistrableSlug('-acme')).toBe(false);
  });

  it('has no empty entries', () => {
    for (const slug of RESERVED_SLUGS) expect(slug.length).toBeGreaterThan(0);
  });
});
