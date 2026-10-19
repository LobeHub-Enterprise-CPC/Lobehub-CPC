import { afterEach, beforeEach, vi } from 'vitest';

import { AgentStreamClient } from '../client';
import { testConfirmation, testTicket } from './fixtures';

// ─── Mock WebSocket ───

export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;

  sent: string[] = [];

  constructor(public url: string) {
    // Auto-connect in next tick
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  // Test helpers
  simulateMessage(data: any): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  simulateError(): void {
    this.onerror?.({});
  }
}

export const mockWsInstances: MockWebSocket[] = [];

beforeEach(() => {
  mockWsInstances.length = 0;
  vi.stubGlobal(
    'WebSocket',
    Object.assign(
      class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          mockWsInstances.push(this);
        }
      },
      {
        CLOSED: MockWebSocket.CLOSED,
        CLOSING: MockWebSocket.CLOSING,
        CONNECTING: MockWebSocket.CONNECTING,
        OPEN: MockWebSocket.OPEN,
      },
    ),
  );
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

export function createClient(
  overrides?: Partial<ConstructorParameters<typeof AgentStreamClient>[0]>,
) {
  return new AgentStreamClient({
    gatewayUrl: 'https://gateway.test.com',
    operationId: 'op-123',
    token: testTicket(),
    ...overrides,
  });
}

export function getLatestWs(): MockWebSocket {
  return mockWsInstances.at(-1)!;
}

export async function connectAndAuth(client: AgentStreamClient): Promise<MockWebSocket> {
  client.connect();
  await vi.advanceTimersByTimeAsync(1);
  const ws = getLatestWs();
  ws.simulateMessage(testConfirmation());
  return ws;
}
