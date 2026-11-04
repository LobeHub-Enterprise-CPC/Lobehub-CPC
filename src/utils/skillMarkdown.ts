import { isRecord, pickString } from '@lobechat/utils';
import { parse, stringify } from 'yaml';

const SKILL_INDEX_FILENAME = 'SKILL.md';
const SKILL_INDEX_FILE_TYPE = 'skills/index';
const SKILL_MARKDOWN_LEADING_WHITESPACE_REGEX = /^\uFEFF?[ \t]*(?:\r?\n[ \t]*)*/;
const SKILL_MARKDOWN_FRONTMATTER_REGEX =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 80;
const UNSAFE_FRONTMATTER_SCALAR_PATTERN = /[\r\n]/;

interface SkillMarkdownDocumentFields {
  filename?: string | null;
  fileType?: string | null;
  title?: string | null;
}

interface SkillMarkdownParts {
  body: string;
  frontmatter?: string;
}

export interface SkillMarkdownMetadataItem {
  key: string;
  value: string;
}

export interface SkillMarkdownFrontmatterFields {
  description?: string;
  name?: string;
}

interface SkillMarkdownMetadataValidationOptions {
  expectedName?: string;
}

export type SkillMarkdownMetadataError =
  | {
      type: 'required';
    }
  | {
      type: 'mapping';
    }
  | {
      type: 'nameRequired';
    }
  | {
      type: 'nameInvalid';
    }
  | {
      expectedName: string;
      type: 'nameLocked';
    }
  | {
      type: 'descriptionRequired';
    }
  | {
      type: 'descriptionInvalid';
    }
  | {
      type: 'syntax';
    };

export const isSkillMarkdownDocument = (document: SkillMarkdownDocumentFields): boolean =>
  document.fileType === SKILL_INDEX_FILE_TYPE ||
  document.filename === SKILL_INDEX_FILENAME ||
  document.title === SKILL_INDEX_FILENAME;

export const parseSkillMarkdownFrontmatter = (content?: string | null): SkillMarkdownParts => {
  if (!content) return { body: '' };

  const normalizedContent = content.replace(SKILL_MARKDOWN_LEADING_WHITESPACE_REGEX, '');
  const match = normalizedContent.match(SKILL_MARKDOWN_FRONTMATTER_REGEX);
  if (!match) return { body: content };

  return {
    body: match[2].replace(/^\r?\n/, ''),
    frontmatter: match[1],
  };
};

export const composeSkillMarkdown = (frontmatter: string | undefined, body: string): string => {
  if (!frontmatter) return body;

  const normalizedFrontmatter = frontmatter.trimEnd();
  if (!body) return `---\n${normalizedFrontmatter}\n---\n`;

  return `---\n${normalizedFrontmatter}\n---\n\n${body.replace(/^\r?\n/, '')}`;
};

const stringifyMetadataValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  // Nested maps and lists stay as indented YAML, which reads like the source
  // instead of a one-line JSON blob.
  return stringify(value).trimEnd();
};

const isValidSkillName = (name: string): boolean =>
  !!name &&
  name.length <= MAX_SKILL_NAME_LENGTH &&
  SKILL_NAME_PATTERN.test(name) &&
  !name.includes('/') &&
  !name.includes('\\') &&
  name !== '.' &&
  name !== '..';

const readFrontmatterStringField = (
  data: Record<string, unknown>,
  field: keyof SkillMarkdownFrontmatterFields,
): string | undefined => {
  const value = data[field];
  return pickString(value)?.trim();
};

export const parseSkillMarkdownFrontmatterFields = (
  frontmatter?: string,
): SkillMarkdownFrontmatterFields => {
  if (!frontmatter) return {};

  try {
    const parsed = parse(frontmatter) as unknown;
    if (!isRecord(parsed)) return {};

    return {
      description: readFrontmatterStringField(parsed, 'description'),
      name: readFrontmatterStringField(parsed, 'name'),
    };
  } catch {
    return {};
  }
};

export const getSkillMarkdownMetadataError = (
  frontmatter?: string,
  options?: SkillMarkdownMetadataValidationOptions,
): SkillMarkdownMetadataError | undefined => {
  if (!frontmatter?.trim()) return { type: 'required' };

  try {
    const parsed = parse(frontmatter) as unknown;
    if (!isRecord(parsed)) {
      return { type: 'mapping' };
    }

    // Keep this client-side guard aligned with server skillManagement/frontmatter.ts so the
    // metadata editor cannot persist SKILL.md frontmatter that later skill code rejects.
    const nameValue = parsed.name;
    if (nameValue === undefined || (typeof nameValue === 'string' && !nameValue.trim())) {
      return { type: 'nameRequired' };
    }
    if (typeof nameValue !== 'string') return { type: 'nameInvalid' };

    const name = nameValue.trim();
    if (!isValidSkillName(name)) return { type: 'nameInvalid' };

    const expectedName = options?.expectedName?.trim();
    if (expectedName && isValidSkillName(expectedName) && name !== expectedName) {
      return { expectedName, type: 'nameLocked' };
    }

    const descriptionValue = parsed.description;
    if (
      descriptionValue === undefined ||
      (typeof descriptionValue === 'string' && !descriptionValue.trim())
    ) {
      return { type: 'descriptionRequired' };
    }
    if (typeof descriptionValue !== 'string') return { type: 'descriptionInvalid' };

    const description = descriptionValue.trim();
    if (UNSAFE_FRONTMATTER_SCALAR_PATTERN.test(description)) {
      return { type: 'descriptionInvalid' };
    }

    return undefined;
  } catch {
    return { type: 'syntax' };
  }
};

const LOOSE_FRONTMATTER_FIELD_REGEX = /^([\w.-]+)[ \t]*:(?:[ \t](.*))?$/;
const QUOTED_SCALAR_REGEX = /^(["'])([\s\S]*)\1$/;

/**
 * Reads frontmatter that strict YAML rejects, as published SKILL.md files often
 * leave a description unquoted around a `: `. Each unindented `key: value` line
 * starts a field; the indented lines below it belong to that field.
 */
const parseLooseSkillMarkdownMetadata = (frontmatter: string): SkillMarkdownMetadataItem[] => {
  const fields: { block: string[]; inline: string; key: string }[] = [];

  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(LOOSE_FRONTMATTER_FIELD_REGEX);
    if (match) {
      fields.push({ block: [], inline: match[2] ?? '', key: match[1] });
    } else if (fields.length > 0 && line.trim()) {
      fields.at(-1)!.block.push(line);
    }
  }

  return fields.map(({ block, inline, key }) => {
    const indent = Math.min(...block.map((line) => line.length - line.trimStart().length));
    const value = [inline, ...block.map((line) => line.slice(indent))]
      .filter(Boolean)
      .join('\n')
      .trim();

    return { key, value: value.replace(QUOTED_SCALAR_REGEX, '$2') };
  });
};

export const parseSkillMarkdownMetadata = (frontmatter?: string): SkillMarkdownMetadataItem[] => {
  if (!frontmatter) return [];

  try {
    const parsed = parse(frontmatter) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

    return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
      key,
      value: stringifyMetadataValue(value),
    }));
  } catch {
    return parseLooseSkillMarkdownMetadata(frontmatter);
  }
};

const FLATTENED_FRONTMATTER_DESCRIPTION_REGEX = /^\s*name:\s.*\sdescription:\s/s;

/**
 * Some catalogues store a skill's description as its frontmatter flattened to
 * one line (`name: x description: …`). Show the SKILL.md's own description
 * field instead whenever that is what came back.
 */
export const getSkillDisplayDescription = (
  description: string | undefined,
  content?: string | null,
): string | undefined => {
  if (!description || !FLATTENED_FRONTMATTER_DESCRIPTION_REGEX.test(description)) {
    return description;
  }

  const { frontmatter } = parseSkillMarkdownFrontmatter(content);
  const fromFrontmatter = parseSkillMarkdownMetadata(frontmatter).find(
    (item) => item.key === 'description',
  )?.value;

  return fromFrontmatter || description;
};

const FLATTENED_DESCRIPTION_KEY = ' description: ';

/**
 * The description of a list row, where no SKILL.md is at hand to consult. Reads
 * what follows the flattened `description:` key, and leaves anything else alone.
 */
export const getSkillListDescription = (description: string | undefined): string | undefined => {
  if (!description || !FLATTENED_FRONTMATTER_DESCRIPTION_REGEX.test(description)) {
    return description;
  }

  const start = description.indexOf(FLATTENED_DESCRIPTION_KEY);

  return description.slice(start + FLATTENED_DESCRIPTION_KEY.length).trim() || description;
};
