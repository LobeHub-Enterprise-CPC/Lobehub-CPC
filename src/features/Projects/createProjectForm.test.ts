import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getCreatedProjectPath,
  getCreateProjectInput,
  getProjectFieldSuggestions,
  isProjectIdentifierValid,
  isProjectSlugValid,
} from './createProjectForm';

// Tests read the distribution's flags; pin the stock (off) value per test.
let mockProjectFirst = false;
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get PROJECT_FIRST_NAVIGATION() {
    return mockProjectFirst;
  },
}));

afterEach(() => {
  mockProjectFirst = false;
});

describe('getCreatedProjectPath', () => {
  it('opens the new project page', () => {
    expect(getCreatedProjectPath({ id: 'prj_1', slug: 'site' })).toBe('/project/site');
    expect(getCreatedProjectPath({ id: 'prj_1', slug: null })).toBe('/project/prj_1');
  });

  it('stays put when projects lead the Home panel', () => {
    mockProjectFirst = true;
    expect(getCreatedProjectPath({ id: 'prj_1', slug: 'site' })).toBeUndefined();
  });
});

describe('createProjectForm', () => {
  it('derives a valid identifier and slug from the project name', () => {
    expect(getProjectFieldSuggestions('LobeHub')).toEqual({
      identifier: 'LOBE',
      slug: 'lobe-hub',
    });
    expect(getProjectFieldSuggestions('LobeHub Mobile')).toEqual({
      identifier: 'LHM',
      slug: 'lobe-hub-mobile',
    });
    expect(getProjectFieldSuggestions('用户记忆')).toEqual({
      identifier: 'YHJY',
      slug: 'yong-hu-ji-yi',
    });
  });

  it('returns empty suggestions when the project name is empty', () => {
    expect(getProjectFieldSuggestions('  ')).toEqual({ identifier: '', slug: '' });
  });

  it('validates the identifier format shown by the form', () => {
    expect(isProjectIdentifierValid('LOBE')).toBe(true);
    expect(isProjectIdentifierValid('LH')).toBe(false);
    expect(isProjectIdentifierValid('1LOBE')).toBe(false);
  });

  it('normalizes and includes a user-provided slug', () => {
    expect(
      getCreateProjectInput({
        identifier: ' lobe ',
        name: '  LobeHub Project  ',
        slug: '  LobeHub-Project  ',
      }),
    ).toEqual({
      identifier: 'LOBE',
      name: 'LobeHub Project',
      slug: 'lobehub-project',
    });
  });

  it('omits an empty slug so the backend can generate one', () => {
    expect(
      getCreateProjectInput({ identifier: 'LOBE', name: 'LobeHub Project', slug: '  ' }),
    ).toEqual({ identifier: 'LOBE', name: 'LobeHub Project' });
  });

  it('rejects malformed slugs', () => {
    expect(isProjectSlugValid('two--hyphens')).toBe(false);
    expect(isProjectSlugValid('contains spaces')).toBe(false);
    expect(
      getCreateProjectInput({ identifier: 'LOBE', name: 'LobeHub Project', slug: '-invalid' }),
    ).toBeNull();
  });
});
