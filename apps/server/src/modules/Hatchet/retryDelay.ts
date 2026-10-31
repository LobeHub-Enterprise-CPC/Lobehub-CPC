type Expression = (retried: number) => number;

const functions: Record<string, { arity: number; run: (...args: number[]) => number }> = {
  abs: { arity: 1, run: Math.abs },
  ceil: { arity: 1, run: Math.ceil },
  exp: { arity: 1, run: Math.exp },
  floor: { arity: 1, run: Math.floor },
  max: { arity: -1, run: Math.max },
  min: { arity: -1, run: Math.min },
  pow: { arity: 2, run: Math.pow },
  round: { arity: 1, run: Math.round },
  sqrt: { arity: 1, run: Math.sqrt },
};

/** Recursive descent builds closures once; no executable source is evaluated. */
export const compileRetryDelay = (expr: string): Expression => {
  const tokens: string[] = [];
  let offset = 0;
  while (offset < expr.length) {
    const match = /^(?:\s+|\d+(?:\.\d*)?|\.\d+|[A-Z_]\w*|[-+*/(),])/i.exec(expr.slice(offset));
    if (!match) throw new Error('Invalid retry delay token');
    if (match[0].trim()) tokens.push(match[0]);
    offset += match[0].length;
  }

  let cursor = 0;
  const consume = (token: string) => {
    if (tokens[cursor] !== token) return false;
    cursor += 1;
    return true;
  };
  const requireToken = (token: string) => {
    if (!consume(token)) throw new Error('Invalid retry delay expression');
  };
  const primary = (): Expression => {
    if (consume('-')) {
      const operand = primary();
      return (retried) => -operand(retried);
    }
    if (consume('(')) {
      const expression = sum();
      requireToken(')');
      return expression;
    }
    const token = tokens[cursor++];
    if (token === undefined) throw new Error('Missing retry delay operand');
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error('Invalid retry delay number');
      return () => value;
    }
    if (token === 'retried') return (retried) => retried;
    if (!Object.hasOwn(functions, token)) throw new Error('Unknown retry delay function');
    const fn = functions[token];
    requireToken('(');
    const args = [sum()];
    while (consume(',')) args.push(sum());
    requireToken(')');
    if (fn.arity !== -1 && args.length !== fn.arity)
      throw new Error('Invalid retry delay function arity');
    return (retried) => fn.run(...args.map((arg) => arg(retried)));
  };
  const product = (): Expression => {
    let left = primary();
    while (tokens[cursor] === '*' || tokens[cursor] === '/') {
      const operator = tokens[cursor++];
      const lhs = left;
      const rhs = primary();
      left = operator === '*' ? (n) => lhs(n) * rhs(n) : (n) => lhs(n) / rhs(n);
    }
    return left;
  };
  const sum = (): Expression => {
    let left = product();
    while (tokens[cursor] === '+' || tokens[cursor] === '-') {
      const operator = tokens[cursor++];
      const lhs = left;
      const rhs = product();
      left = operator === '+' ? (n) => lhs(n) + rhs(n) : (n) => lhs(n) - rhs(n);
    }
    return left;
  };
  const expression = sum();
  if (cursor !== tokens.length) throw new Error('Unexpected retry delay token');
  return (retried) => {
    const result = expression(retried);
    if (!Number.isFinite(result) || result < 0) throw new Error('Invalid retry delay result');
    return result;
  };
};

export const defaultRetryDelayMs = (n: number): number => Math.min(86400, Math.exp(2.5 * n)) * 1000;

const durationUnits: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1000,
  ms: 1,
  us: 0.001,
  µs: 0.001,
  μs: 0.001,
  ns: 0.000001,
};

export const parseRetryAfter = (value: string, now: number): number | undefined => {
  const text = value.trim();
  let milliseconds: number;
  if (/^\d+$/.test(text)) {
    milliseconds = Number(text) * 1000;
  } else if (/^\+?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|[smh]))+$/.test(text)) {
    milliseconds = 0;
    for (const match of text.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|[smh])/g))
      milliseconds += Number(match[1]) * durationUnits[match[2]];
  } else if (/^[A-Z]{3}[, ]/i.test(text)) {
    milliseconds = Date.parse(text) - now;
  } else {
    return undefined;
  }
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
};
