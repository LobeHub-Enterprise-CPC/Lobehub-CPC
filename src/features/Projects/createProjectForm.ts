import { PROJECT_FIRST_NAVIGATION } from '@lobechat/business-const';
import {
  PROJECT_DUPLICATE_IDENTIFIER,
  PROJECT_DUPLICATE_SLUG,
  PROJECT_IDENTIFIER_REGEX,
  type ProjectDuplicateField,
} from '@lobechat/types';
import { kebabCase } from 'es-toolkit';
import { pinyin } from 'pinyin-pro';

import { isTrpcErrorCode } from '@/utils/trpcError';

const PROJECT_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface CreateProjectDraft {
  identifier: string;
  name: string;
  slug: string;
}

export interface ProjectFieldSuggestions {
  slug: string;
}

export const getProjectFieldSuggestions = (name: string): ProjectFieldSuggestions => {
  const normalizedName = name.trim();
  if (!normalizedName) return { slug: '' };

  const transliteratedName = pinyin(normalizedName, {
    nonZh: 'consecutive',
    toneType: 'none',
    type: 'array',
  }).join(' ');
  const slug = kebabCase(transliteratedName).replaceAll(/[^a-z0-9-]/g, '');

  return { slug };
};

export const isProjectIdentifierValid = (identifier: string) =>
  PROJECT_IDENTIFIER_REGEX.test(identifier.trim().toUpperCase());

export const getProjectConflictField = (error: unknown): ProjectDuplicateField | undefined => {
  if (!isTrpcErrorCode(error, 'CONFLICT') || !error || typeof error !== 'object') return;
  if (!('message' in error)) return;
  if (error.message === PROJECT_DUPLICATE_IDENTIFIER) return 'identifier';
  if (error.message === PROJECT_DUPLICATE_SLUG) return 'slug';
};

export const isProjectSlugValid = (slug: string) => {
  const normalizedSlug = slug.trim().toLowerCase();
  return !normalizedSlug || PROJECT_SLUG_REGEX.test(normalizedSlug);
};

export const getCreateProjectInput = (draft: CreateProjectDraft) => {
  const identifier = draft.identifier.trim().toUpperCase();
  const name = draft.name.trim();
  const slug = draft.slug.trim().toLowerCase();

  // The identifier is optional; left empty, tasks keep the default prefix.
  if (!name || (identifier && !isProjectIdentifierValid(identifier)) || !isProjectSlugValid(slug)) {
    return null;
  }

  return { name, ...(identifier ? { identifier } : {}), ...(slug ? { slug } : {}) };
};

/**
 * Where a project created from a plain "New project" leads: its page, or
 * nowhere when projects lead the Home panel, which lists the new one at once.
 */
export const getCreatedProjectPath = (project: { id: string; slug?: string | null }) =>
  PROJECT_FIRST_NAVIGATION ? undefined : `/project/${project.slug ?? project.id}`;
