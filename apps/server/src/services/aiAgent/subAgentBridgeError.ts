import { TRPCError } from '@trpc/server';

/** Binding failures must reach the caller before a child can be scheduled. */
export class SubAgentBridgeError extends TRPCError {
  constructor(code: 'PRECONDITION_FAILED' | 'SERVICE_UNAVAILABLE', cause?: unknown) {
    super({
      cause,
      code,
      message:
        code === 'PRECONDITION_FAILED'
          ? 'Sub-agent bridge parent batch unavailable'
          : 'Sub-agent bridge persistence unavailable',
    });
  }
}
