import { TenantDatabaseError } from './errors';

interface SqlToken {
  kind: 'code' | 'comment' | 'quoted' | 'space';
  text: string;
}

const rejectSql = (): never => {
  throw new TenantDatabaseError('TENANT_NOT_READY', 'migration-failed');
};

const lineEnd = (sql: string, start: number) => {
  const lf = sql.indexOf('\n', start);
  const cr = sql.indexOf('\r', start);
  if (lf < 0) return cr < 0 ? sql.length : cr;
  return cr < 0 ? lf : Math.min(lf, cr);
};

/** Keep quoted values intact; dollar bodies are recursively inspected as SQL. */
const lexSql = (sql: string, depth = 0, preserveDollarData = false): SqlToken[] => {
  if (depth > 32) return rejectSql();
  const tokens: SqlToken[] = [];
  let index = 0;
  let codeStart = 0;
  const flushCode = () => {
    if (index > codeStart) tokens.push({ kind: 'code', text: sql.slice(codeStart, index) });
  };
  const emit = (kind: SqlToken['kind'], start: number) => {
    tokens.push({ kind, text: sql.slice(start, index) });
    codeStart = index;
  };
  while (index < sql.length) {
    const start = index;
    if (/\s/.test(sql[index])) {
      flushCode();
      while (index < sql.length && /\s/.test(sql[index])) index++;
      emit('space', start);
    } else if (sql.startsWith('--', index)) {
      flushCode();
      index = lineEnd(sql, index + 2);
      emit('comment', start);
    } else if (sql.startsWith('/*', index)) {
      flushCode();
      index += 2;
      let nesting = 1;
      while (index < sql.length && nesting > 0) {
        if (sql.startsWith('/*', index)) {
          nesting++;
          index += 2;
        } else if (sql.startsWith('*/', index)) {
          nesting--;
          index += 2;
        } else index++;
      }
      if (nesting) return rejectSql();
      emit('comment', start);
    } else if (sql[index] === "'" || sql[index] === '"') {
      flushCode();
      const quote = sql[index++];
      const escapes =
        quote === "'" &&
        /e/i.test(sql[start - 1] ?? '') &&
        (start < 2 || !/[\w$]/.test(sql[start - 2]));
      let closed = false;
      while (index < sql.length) {
        if (escapes && sql[index] === '\\') index += 2;
        else if (sql[index] === quote) {
          if (sql[index + 1] === quote) index += 2;
          else {
            index++;
            closed = true;
            break;
          }
        } else index++;
      }
      if (!closed) return rejectSql();
      emit('quoted', start);
    } else {
      const delimiter =
        sql[index] === '$' && (index === 0 || !/[\w$\u0080-\uFFFF]/u.test(sql[index - 1]))
          ? /^\$(?:[A-Z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)?\$/iu.exec(sql.slice(index))?.[0]
          : undefined;
      if (!delimiter) {
        index++;
        continue;
      }
      flushCode();
      const bodyStart = index + delimiter.length;
      // PostgreSQL ends a dollar quote at the first matching delimiter, even
      // when that text occurs inside a body-language string or comment.
      const end = sql.indexOf(delimiter, bodyStart);
      if (end < 0) return rejectSql();
      if (preserveDollarData && !/\b(?:DO|AS)\s*$/i.test(sql.slice(0, start))) {
        tokens.push({ kind: 'quoted', text: sql.slice(start, end + delimiter.length) });
      } else {
        tokens.push({ kind: 'code', text: delimiter });
        tokens.push(...lexSql(sql.slice(bodyStart, end), depth + 1, preserveDollarData));
        tokens.push({ kind: 'code', text: delimiter });
      }
      index = end + delimiter.length;
      codeStart = index;
    }
  }
  flushCode();
  return tokens;
};

/** Comment separators become spaces; literal/identifier contents remain unchanged. */
export const tenantMigrationSqlWithoutComments = (sql: string): string =>
  lexSql(sql)
    .map((token) => (token.kind === 'comment' ? ' ' : token.text))
    .join('');

/** Only full header lines may be omitted when recognizing a reviewed migration. */
export const withoutMigrationHeader = (sql: string): string => {
  let index = 0;
  while (index < sql.length) {
    while (index < sql.length && /\s/.test(sql[index])) index++;
    if (!sql.startsWith('--', index)) return sql.slice(index);
    const newline = lineEnd(sql, index + 2);
    if (newline === sql.length) return '';
    index = newline + 1;
  }
  return '';
};

/** Whitespace normalization never changes a quoted string or identifier. */
export const matchesReviewedTenantMigration = (sql: string, reviewed: string): boolean => {
  const normalize = (text: string) =>
    lexSql(text)
      .map((token) => (token.kind === 'space' ? ' ' : token.text))
      .join('')
      .trim();
  return normalize(withoutMigrationHeader(sql)) === normalize(reviewed);
};

/** The only context a qualifier decision looks at; bounded so a large statement stays linear. */
const CONTEXT_CHARS = 1024;

/** The schema a chain is authored against, unless it declares a placeholder. */
export const DEFAULT_SOURCE_SCHEMA = 'public';

interface RewriteTarget {
  /** `public.` as an unquoted qualifier. */
  qualifier: RegExp;
  /** Quoted target schema, e.g. `"tenant_x"`. */
  quoted: string;
  /** `'public.` / `'"public".` at the start of a relation-name literal. */
  relationLiteral: RegExp;
  /** The authored schema's name: `public`, or a declared placeholder. */
  source: string;
}

/**
 * Rewrite schema qualifiers without changing data strings, comments or unrelated identifiers.
 * `sourceSchema` is `public` for a chain authored against it. A chain generated against a
 * declared placeholder (Enterprise's `tenant_template`) names that instead; nothing else
 * changes, except that the placeholder, unlike `public`, is never real data: its quoted
 * literal is the schema name in any context (`format('%I.%I', 'tenant_template', t)`).
 */
export const rewriteTenantSchemaQualifiers = (
  statement: string,
  schemaName: string,
  sourceSchema: string = DEFAULT_SOURCE_SCHEMA,
) => {
  if (!/^[_a-z][\d_a-z]*$/.test(sourceSchema)) return rejectSql();
  const tokens = lexSql(statement, 0, true);
  const target: RewriteTarget = {
    qualifier: new RegExp(`(?<![\\w"$.])${sourceSchema}\\.(?=["A-Z_a-z])`, 'g'),
    quoted: `"${schemaName}"`,
    relationLiteral: new RegExp(`^'(?:"${sourceSchema}"|${sourceSchema})\\.`),
    source: sourceSchema,
  };
  const lookahead = (from: number) => {
    let text = '';
    for (let index = from; index < tokens.length && text.length < CONTEXT_CHARS; index += 1)
      text += tokens[index].text;
    return text;
  };
  let before = '';
  const rewritten: string[] = [];
  tokens.forEach((token, index) => {
    rewritten.push(rewriteToken(token, before, index, lookahead, target));
    before = (before + token.text).slice(-CONTEXT_CHARS);
  });
  return rewritten.join('');
};

const rewriteToken = (
  token: SqlToken,
  before: string,
  index: number,
  lookahead: (from: number) => string,
  { qualifier, quoted, relationLiteral, source }: RewriteTarget,
) => {
  if (token.kind === 'comment') return token.text;
  if (token.kind === 'quoted') {
    if (
      token.text === `"${source}"` &&
      lookahead(index + 1).startsWith('.') &&
      !/[\w".]$/.test(before)
    )
      return quoted;
    if (token.text.startsWith("'")) {
      if (source !== DEFAULT_SOURCE_SCHEMA && token.text === `'${source}'`)
        return `'${quoted.slice(1, -1)}'`;
      // Only SQL relation-name contexts interpret these strings as identifiers.
      if (
        /^\s*::\s*(?:pg_catalog\.)?regclass\b/i.test(lookahead(index + 1)) ||
        /\bto_regclass\s*\(\s*$/i.test(before)
      )
        return token.text.replace(relationLiteral, `'${quoted}.`);
    }
    return token.text;
  }
  return token.text.replaceAll(qualifier, (match, offset: number) =>
    offset === 0 && /[\w"$.]$/.test(before) ? match : `${quoted}.`,
  );
};

/** Schema safety checks ignore ordinary data literals, whose contents are never SQL identifiers. */
export const tenantMigrationSqlWithoutData = (statement: string) =>
  lexSql(statement, 0, true)
    .map((token) =>
      token.kind === 'comment' ||
      (token.kind === 'quoted' && (token.text.startsWith("'") || token.text.startsWith('$')))
        ? ' '
        : token.text,
    )
    .join('');
