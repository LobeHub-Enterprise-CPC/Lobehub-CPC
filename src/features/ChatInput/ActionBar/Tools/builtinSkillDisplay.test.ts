import { builtinSkillManifests, LobeHubIdentifier } from '@lobechat/builtin-skills/manifests';
import { afterEach, expect, it, vi } from 'vitest';

import { getBuiltinSkillDisplayIdentifier } from './builtinSkillDisplay';

const branding = vi.hoisted(() => ({ name: 'Acme Workspace' }));
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get BRANDING_NAME() {
    return branding.name;
  },
}));

afterEach(() => {
  branding.name = 'Acme Workspace';
});

it('brands the display ID without changing the builtin runtime contract', () => {
  const skill = builtinSkillManifests.find((item) => item.identifier === LobeHubIdentifier)!;
  expect(skill.identifier).toBe('lobehub');
  expect(skill.name).toBe('Acme Workspace');
  expect(getBuiltinSkillDisplayIdentifier(skill.identifier)).toBe('acmeworkspace');
  expect(skill.identifier).toBe('lobehub');
});

it('keeps the upstream brand and unrelated skill identifiers unchanged', () => {
  branding.name = 'LobeHub';
  expect(getBuiltinSkillDisplayIdentifier('lobehub')).toBe('lobehub');
  branding.name = 'Acme Workspace';
  for (const id of ['artifacts', 'task', 'lobe-skills', 'lobehub-custom']) {
    expect(getBuiltinSkillDisplayIdentifier(id)).toBe(id);
  }
});
