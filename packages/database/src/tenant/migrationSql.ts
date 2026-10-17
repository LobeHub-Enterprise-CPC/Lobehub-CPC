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
const lexSql = (sql: string, depth = 0): SqlToken[] => {
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
      tokens.push({ kind: 'code', text: delimiter });
      tokens.push(...lexSql(sql.slice(bodyStart, end), depth + 1));
      tokens.push({ kind: 'code', text: delimiter });
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
