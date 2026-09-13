import { describe, expect, it } from 'vitest';

import { buildWorkspaceAwarePath } from '../workspaceAwarePath';

describe('buildWorkspaceAwarePath', () => {
  it('returns the path unchanged when no active workspace slug exists', () => {
    expect(buildWorkspaceAwarePath('/memory', null)).toBe('/memory');
    expect(buildWorkspaceAwarePath('/memory', undefined)).toBe('/memory');
  });

  it('prefixes absolute paths with the active workspace slug', () => {
    expect(buildWorkspaceAwarePath('/memory', 'acme')).toBe('/acme/memory');
    expect(buildWorkspaceAwarePath('/agent/inbox', 'acme')).toBe('/acme/agent/inbox');
    expect(buildWorkspaceAwarePath('/image?model=image-model', 'acme')).toBe(
      '/acme/image?model=image-model',
    );
    expect(buildWorkspaceAwarePath('/video?model=video-model', 'acme')).toBe(
      '/acme/video?model=video-model',
    );
    expect(buildWorkspaceAwarePath('/community/agent/jailbreak', 'acme')).toBe(
      '/acme/community/agent/jailbreak',
    );
    expect(buildWorkspaceAwarePath('/group/group-1', 'acme')).toBe('/acme/group/group-1');
    expect(buildWorkspaceAwarePath('/project/project-1', 'acme')).toBe('/acme/project/project-1');
    expect(buildWorkspaceAwarePath('/projects', 'acme')).toBe('/acme/projects');
  });

  it('prefixes deep agent and evaluation paths used by cross-page navigation', () => {
    expect(buildWorkspaceAwarePath('/agent/agent-1/profile', 'acme')).toBe(
      '/acme/agent/agent-1/profile',
    );
    expect(buildWorkspaceAwarePath('/agent/agent-1/topic-1', 'acme')).toBe(
      '/acme/agent/agent-1/topic-1',
    );
    expect(buildWorkspaceAwarePath('/eval/bench/bench-1/runs/run-1/cases/case-1', 'acme')).toBe(
      '/acme/eval/bench/bench-1/runs/run-1/cases/case-1',
    );
  });

  it('bypasses the prefix when `escape` is true', () => {
    expect(buildWorkspaceAwarePath('/settings/memory', 'acme', { escape: true })).toBe(
      '/settings/memory',
    );
    expect(buildWorkspaceAwarePath('/settings/plans', 'acme', { escape: true })).toBe(
      '/settings/plans',
    );
  });

  it('does not double-prefix when the path is already under the active slug', () => {
    expect(buildWorkspaceAwarePath('/acme', 'acme')).toBe('/acme');
    expect(buildWorkspaceAwarePath('/acme/memory', 'acme')).toBe('/acme/memory');
  });

  it('does not prefix paths already qualified by another workspace slug', () => {
    expect(buildWorkspaceAwarePath('/test-team/agent/agent-1', 'acme')).toBe(
      '/test-team/agent/agent-1',
    );
    expect(buildWorkspaceAwarePath('/test-team/settings/general', 'acme')).toBe(
      '/test-team/settings/general',
    );
  });

  it('leaves relative paths alone (router resolves them)', () => {
    expect(buildWorkspaceAwarePath('memory', 'acme')).toBe('memory');
    expect(buildWorkspaceAwarePath('../tasks', 'acme')).toBe('../tasks');
  });

  it('skips prefix for personal-only top-level paths', () => {
    expect(buildWorkspaceAwarePath('/apps', 'acme')).toBe('/apps');
    expect(buildWorkspaceAwarePath('/onboarding/agent', 'acme')).toBe('/onboarding/agent');
    expect(buildWorkspaceAwarePath('/me/profile', 'acme')).toBe('/me/profile');
    expect(buildWorkspaceAwarePath('/share/t/foo', 'acme')).toBe('/share/t/foo');
    expect(buildWorkspaceAwarePath('/devtools', 'acme')).toBe('/devtools');
    // Workspace invite acceptance is a standalone root-level page (no
    // `/:workspaceSlug` mirror), so notifications linking to it must not be
    // prefixed while the recipient sits inside another workspace.
    expect(buildWorkspaceAwarePath('/invite/tok-123', 'acme')).toBe('/invite/tok-123');
  });

  it('prefixes settings sub-paths that have a workspace mirror', () => {
    expect(buildWorkspaceAwarePath('/settings/general', 'acme')).toBe('/acme/settings/general');
    expect(buildWorkspaceAwarePath('/settings/members', 'acme')).toBe('/acme/settings/members');
    expect(buildWorkspaceAwarePath('/settings/plans', 'acme')).toBe('/acme/settings/plans');
    expect(buildWorkspaceAwarePath('/settings/billing', 'acme')).toBe('/acme/settings/billing');
    expect(buildWorkspaceAwarePath('/settings/credits', 'acme')).toBe('/acme/settings/credits');
    expect(buildWorkspaceAwarePath('/settings/usage', 'acme')).toBe('/acme/settings/usage');
    expect(buildWorkspaceAwarePath('/settings/skill', 'acme')).toBe('/acme/settings/skill');
    expect(buildWorkspaceAwarePath('/settings/connector', 'acme')).toBe('/acme/settings/connector');
    expect(buildWorkspaceAwarePath('/settings/devices', 'acme')).toBe('/acme/settings/devices');
    expect(buildWorkspaceAwarePath('/settings/labels', 'acme')).toBe('/acme/settings/labels');
    expect(buildWorkspaceAwarePath('/settings/audit-log', 'acme')).toBe('/acme/settings/audit-log');
    expect(buildWorkspaceAwarePath('/settings/storage', 'acme')).toBe('/acme/settings/storage');
    expect(buildWorkspaceAwarePath('/settings/credential', 'acme')).toBe(
      '/acme/settings/credential',
    );
    // Legacy alias — prefixed, then the router redirects to `credential`.
    expect(buildWorkspaceAwarePath('/settings/creds', 'acme')).toBe('/acme/settings/creds');
    expect(buildWorkspaceAwarePath('/settings/statistics', 'acme')).toBe(
      '/acme/settings/statistics',
    );
    // Legacy alias — prefixed, then the router redirects to `statistics`.
    expect(buildWorkspaceAwarePath('/settings/stats', 'acme')).toBe('/acme/settings/stats');
    expect(buildWorkspaceAwarePath('/settings/oauth-apps', 'acme')).toBe(
      '/acme/settings/oauth-apps',
    );
    expect(buildWorkspaceAwarePath('/settings/oauth-apps/client-1', 'acme')).toBe(
      '/acme/settings/oauth-apps/client-1',
    );
    expect(buildWorkspaceAwarePath('/settings/provider/openai', 'acme')).toBe(
      '/acme/settings/provider/openai',
    );
  });

  // Account-level tabs are mirrored under the workspace so members can reach
  // them without leaving it.
  it('prefixes the account-level settings tabs', () => {
    expect(buildWorkspaceAwarePath('/settings/profile', 'acme')).toBe('/acme/settings/profile');
    expect(buildWorkspaceAwarePath('/settings/appearance', 'acme')).toBe(
      '/acme/settings/appearance',
    );
    expect(buildWorkspaceAwarePath('/settings/hotkey', 'acme')).toBe('/acme/settings/hotkey');
    expect(buildWorkspaceAwarePath('/settings/messenger', 'acme')).toBe('/acme/settings/messenger');
    expect(buildWorkspaceAwarePath('/settings/messenger/slack', 'acme')).toBe(
      '/acme/settings/messenger/slack',
    );
    expect(buildWorkspaceAwarePath('/settings/advanced', 'acme')).toBe('/acme/settings/advanced');
    expect(buildWorkspaceAwarePath('/settings/labs', 'acme')).toBe('/acme/settings/labs');
    expect(buildWorkspaceAwarePath('/settings/about', 'acme')).toBe('/acme/settings/about');
  });

  it('skips prefix for personal-only settings sub-paths', () => {
    expect(buildWorkspaceAwarePath('/settings/llm', 'acme')).toBe('/settings/llm');
    expect(buildWorkspaceAwarePath('/settings/memory', 'acme')).toBe('/settings/memory');
    expect(buildWorkspaceAwarePath('/settings/referral', 'acme')).toBe('/settings/referral');
    expect(buildWorkspaceAwarePath('/settings/system-tools', 'acme')).toBe(
      '/settings/system-tools',
    );
  });

  it('prefixes the `/settings` index — both personal and workspace have a meaningful redirect', () => {
    expect(buildWorkspaceAwarePath('/settings', 'acme')).toBe('/acme/settings');
    expect(buildWorkspaceAwarePath('/settings/', 'acme')).toBe('/acme/settings/');
    expect(buildWorkspaceAwarePath('/settings?foo=bar', 'acme')).toBe('/acme/settings?foo=bar');
  });
});

describe('buildWorkspaceAwarePath under a tenant prefix', () => {
  // The failure this suite exists for is SILENT. The main-area route tree has a
  // `:workspaceSlug` segment, so an unhandled `/t/...` url does not throw — it
  // resolves with `workspaceSlug = 't'` and renders a 404 or the wrong page.
  // `spa/BootShell/routeScope.ts` records the same bug shape for the dev-proxy
  // prefix being eaten as a slug.

  it('applies the workspace prefix INSIDE the tenant prefix', () => {
    expect(buildWorkspaceAwarePath('/t/acme/agent', 'ws')).toBe('/t/acme/ws/agent');
    expect(buildWorkspaceAwarePath('/t/acme/settings/general', 'ws')).toBe(
      '/t/acme/ws/settings/general',
    );
  });

  it('never yields a path whose first segment is the workspace slug', () => {
    // i.e. never `/ws/t/acme/...` — the tenant must stay outermost, or the
    // tenant segment lands inside the workspace subtree and stops being parsed.
    const out = buildWorkspaceAwarePath('/t/acme/agent', 'ws');
    expect(out.startsWith('/t/')).toBe(true);
    expect(out.startsWith('/ws/')).toBe(false);
  });

  it('still recognises personal-only paths through the tenant prefix', () => {
    // Before the fix these read `t` as the first segment, matched no allowlist,
    // and silently skipped the workspace prefix for every path alike — making
    // the personal/workspace distinction disappear rather than be respected.
    expect(buildWorkspaceAwarePath('/t/acme/apps', 'ws')).toBe('/t/acme/apps');
    expect(buildWorkspaceAwarePath('/t/acme/me', 'ws')).toBe('/t/acme/me');
    expect(buildWorkspaceAwarePath('/t/acme/settings/llm', 'ws')).toBe('/t/acme/settings/llm');
  });

  it('still skips non-mirrored first segments through the tenant prefix', () => {
    expect(buildWorkspaceAwarePath('/t/acme/downloads', 'ws')).toBe('/t/acme/downloads');
  });

  it('does not double-apply when the workspace prefix is already there', () => {
    expect(buildWorkspaceAwarePath('/t/acme/ws/agent', 'ws')).toBe('/t/acme/ws/agent');
  });

  it('behaves exactly as before when there is no tenant prefix', () => {
    expect(buildWorkspaceAwarePath('/agent', 'ws')).toBe('/ws/agent');
    expect(buildWorkspaceAwarePath('/apps', 'ws')).toBe('/apps');
  });

  it('treats the tenant root exactly as it treats the unprefixed root', () => {
    // `/` already maps to `/ws/` (trailing slash and all) — the tenant-prefixed
    // root must inherit that, not invent its own rule. Asserted as an invariant
    // against the unprefixed case so the two cannot drift.
    const unprefixed = buildWorkspaceAwarePath('/', 'ws');
    expect(buildWorkspaceAwarePath('/t/acme', 'ws')).toBe(`/t/acme${unprefixed}`);
  });
});
