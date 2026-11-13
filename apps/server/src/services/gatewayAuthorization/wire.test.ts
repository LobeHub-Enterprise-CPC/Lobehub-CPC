import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseGatewayWire } from './wire';

describe.each(['token-claims', 'authorize', 'lifecycle', 'ws-auth', 'mux', 'dispatch'])(
  'v2 %s wire fixtures',
  (name) => {
    it('accepts and rejects all normative wire examples', async () => {
      const fixture = JSON.parse(
        await readFile(
          new URL(
            `../../../../../contracts/gateway-tenancy/v2/fixtures/${name}.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      ) as {
        contractVersion: number;
        cases: {
          id: string;
          validation: string;
          schema: Parameters<typeof parseGatewayWire>[0];
          input: unknown;
          expected: { accepted: boolean; code?: string };
        }[];
      };
      expect(fixture.contractVersion).toBe(2);
      const cases = fixture.cases.filter((entry) => entry.validation === 'wire');
      expect(cases.length).toBeGreaterThan(0);
      for (const entry of cases) {
        const parse = () => parseGatewayWire(entry.schema, entry.input);
        if (entry.expected.accepted) expect(parse, entry.id).not.toThrow();
        // This parser tests structural admission; owning endpoints map safe errors.
        else expect(parse, entry.id).toThrow('INVALID_GATEWAY_MESSAGE');
      }
    });
  },
);
