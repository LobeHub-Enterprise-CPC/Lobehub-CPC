import type WebSocket from 'ws';

export const attachGatewaySocket = (
  socket: WebSocket,
  isCurrent: () => boolean,
  handlers: {
    open: () => void;
    message: (data: WebSocket.Data) => void;
    close: (code: number, reason: Buffer) => void;
    error: (error: Error) => void;
  },
) => {
  const open = () => {
    if (isCurrent()) handlers.open();
  };
  const message = (data: WebSocket.Data) => {
    if (isCurrent()) handlers.message(data);
  };
  const close = (code: number, reason: Buffer) => {
    if (isCurrent()) handlers.close(code, reason);
  };
  const error = (error: Error) => {
    if (isCurrent()) handlers.error(error);
  };
  socket.on('open', open).on('message', message).on('close', close).on('error', error);
  return () => {
    socket.off('open', open).off('message', message).off('close', close).off('error', error);
  };
};

export const assertDeviceCommandPayload = (raw: unknown) => {
  const frame = raw as Record<string, any>;
  const string = (v: unknown) => typeof v === 'string' && v.length > 0;
  if (frame.type === 'tool_call_request') {
    const call = frame.toolCall;
    if (
      !call ||
      !string(call.identifier) ||
      !string(call.apiName) ||
      typeof call.arguments !== 'string' ||
      !['tool', 'mcp'].includes(call.type) ||
      (call.type === 'mcp' && !['stdio', 'http'].includes(call.params?.type))
    )
      throw new Error('INVALID_GATEWAY_MESSAGE');
  } else if (frame.type === 'rpc_request') {
    if (!string(frame.method)) throw new Error('INVALID_GATEWAY_MESSAGE');
  } else if (frame.type === 'message_api_request') {
    if (
      !string(frame.api?.apiName) ||
      !string(frame.api?.platform) ||
      !frame.api?.payload ||
      typeof frame.api.payload !== 'object'
    )
      throw new Error('INVALID_GATEWAY_MESSAGE');
  } else if (
    frame.type === 'agent_run_request' &&
    (!string(frame.operationId) || !string(frame.agentType) || typeof frame.prompt !== 'string')
  )
    throw new Error('INVALID_GATEWAY_MESSAGE');
};

/** Best-effort expiry diagnostics; never logs the token. */
export const describeGatewayTokenExpiry = (token: string): string => {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (typeof payload.exp !== 'number') return 'token exp: none';
    const expired = Date.now() >= payload.exp * 1000;
    return `token exp: ${new Date(payload.exp * 1000).toISOString()}${expired ? ' (EXPIRED)' : ''}`;
  } catch {
    return 'token exp: unparsable';
  }
};
