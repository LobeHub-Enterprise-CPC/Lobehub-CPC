import Ajv2020 from 'ajv/dist/2020';

import schema from '../../../../../contracts/gateway-tenancy/v1/schema.json';

export class GatewayAuthorizationError extends Error {
  constructor(
    readonly code: string,
    readonly status = 401,
  ) {
    super(code);
    this.name = 'GatewayAuthorizationError';
  }
}
const ajv = new Ajv2020({ strict: false });
ajv.addSchema(schema);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
export const parseGatewayWire = <T>(definition: keyof typeof schema.$defs, input: unknown): T => {
  let validate = validators.get(definition);
  if (!validate) {
    validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
    validators.set(definition, validate);
  }
  if (!validate(input)) throw new GatewayAuthorizationError('INVALID_GATEWAY_MESSAGE', 400);
  return input as T;
};
export const samePrincipal = (a: { kind: string; id: string }, b: { kind: string; id: string }) =>
  a.kind === b.kind && a.id === b.id;
