import {
  ArtifactsIdentifier,
  builtinSkillManifests,
  LobeHubIdentifier,
} from '@lobechat/builtin-skills/manifests';
import { afterEach, expect, it, vi } from 'vitest';

import { getBuiltinSkillDisplayIdentifier } from './builtinSkillDisplay';

const branding = vi.hoisted(() => ({
  displayIdentifiers: {} as Record<string, string>,
  name: 'Acme Workspace',
}));
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get BRANDING_NAME() {
    return branding.name;
  },
  get BUILTIN_SKILL_DISPLAY_IDENTIFIERS() {
    return branding.displayIdentifiers;
  },
}));

afterEach(() => {
  branding.displayIdentifiers = {};
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
  for (const id of ['artifacts', 'lobe-artifacts', 'task', 'lobe-skills', 'lobehub-custom']) {
    expect(getBuiltinSkillDisplayIdentifier(id)).toBe(id);
  }
});

it('shows a distribution display ID while the skill keeps its runtime identifier', () => {
  branding.displayIdentifiers = { [ArtifactsIdentifier]: 'acme-portfolio' };
  const skill = builtinSkillManifests.find((item) => item.identifier === ArtifactsIdentifier)!;

  expect(getBuiltinSkillDisplayIdentifier(skill.identifier)).toBe('acme-portfolio');
  expect(skill.identifier).toBe('lobe-artifacts');
  expect(getBuiltinSkillDisplayIdentifier('task')).toBe('task');
});

it('lets the display map override the branded LobeHub ID', () => {
  branding.displayIdentifiers = { [LobeHubIdentifier]: 'acme' };
  expect(getBuiltinSkillDisplayIdentifier(LobeHubIdentifier)).toBe('acme');
});

it('ignores prototype members of the display map', () => {
  for (const id of ['constructor', 'toString', '__proto__']) {
    expect(getBuiltinSkillDisplayIdentifier(id)).toBe(id);
  }
});
