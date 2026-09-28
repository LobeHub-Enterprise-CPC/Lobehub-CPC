import { builtinSkillManifests, LobeHubIdentifier } from '@lobechat/builtin-skills/manifests';
import { afterEach, expect, it, vi } from 'vitest';

import { getBuiltinSkillDisplayIdentifier } from './builtinSkillDisplay';

const branding = vi.hoisted(() => ({ name: 'TITU Work' }));
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get BRANDING_NAME() {
    return branding.name;
  },
}));

afterEach(() => {
  branding.name = 'TITU Work';
});

it('brands the display ID without changing the builtin runtime contract', () => {
  const skill = builtinSkillManifests.find((item) => item.identifier === LobeHubIdentifier)!;
  expect(skill.identifier).toBe('lobehub');
  expect(skill.name).toBe('lobehub');
  expect(getBuiltinSkillDisplayIdentifier(skill.identifier)).toBe('tituwork');
  expect(skill.identifier).toBe('lobehub');
});

it('keeps the upstream brand and unrelated skill identifiers unchanged', () => {
  branding.name = 'LobeHub';
  expect(getBuiltinSkillDisplayIdentifier('lobehub')).toBe('lobehub');
  branding.name = 'TITU Work';
  for (const id of ['artifacts', 'task', 'lobe-skills', 'lobehub-custom']) {
    expect(getBuiltinSkillDisplayIdentifier(id)).toBe(id);
  }
});
