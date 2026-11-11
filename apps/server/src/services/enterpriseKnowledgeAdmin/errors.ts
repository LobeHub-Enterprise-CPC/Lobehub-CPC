export type KbAdminErrorCode =
  | 'INVALID_PRINCIPAL'
  | 'STALE_VERSION'
  | 'INVALID_REQUEST'
  | 'NAME_EXISTS'
  | 'NOT_ENABLED'
  | 'NOT_FOUND'
  | 'OWNER_DISABLED'
  | 'OWNER_NOT_FOUND'
  | 'TRANSFER_BUSY'
  | 'TRANSFER_SAME_OWNER';

/** Error codes of the governance knowledge-base contract and the HTTP status each maps to. */
export const KB_ADMIN_ERROR_STATUS = {
  INVALID_REQUEST: 400,
  INVALID_PRINCIPAL: 422,
  STALE_VERSION: 409,
  NAME_EXISTS: 409,
  NOT_ENABLED: 501,
  NOT_FOUND: 404,
  OWNER_DISABLED: 422,
  OWNER_NOT_FOUND: 422,
  TRANSFER_BUSY: 409,
  TRANSFER_SAME_OWNER: 422,
} as const satisfies Record<KbAdminErrorCode, number>;

export class KbAdminError extends Error {
  readonly code: KbAdminErrorCode;

  constructor(code: KbAdminErrorCode, message: string) {
    super(message);
    this.name = 'KbAdminError';
    this.code = code;
  }
}

export const notFound = (what = 'Knowledge base') =>
  new KbAdminError('NOT_FOUND', `${what} not found`);

export const invalidRequest = (message: string) => new KbAdminError('INVALID_REQUEST', message);
