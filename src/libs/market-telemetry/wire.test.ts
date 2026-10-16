import { describe, expect, it } from 'vitest';

import {
  buildInteractionReport,
  buildPluginInstallReport,
  buildToolCallReport,
  completedFromEnvelope,
  type CompletedTelemetryExecution,
} from './index';

const completed = (overrides: Partial<CompletedTelemetryExecution> = {}) =>
  Object.freeze({
    attempt: 1,
    durationMs: 42,
    eventId: 'v1:call:op:tc:1',
    eventType: 'call' as const,
    occurredAt: '2026-10-16T08:00:00.000Z',
    success: true,
    ...overrides,
  });

describe('buildToolCallReport', () => {
  const descriptor = {
    identifier: 'github',
    mcpType: 'cloud',
    methodName: 'search',
    version: '1.2.0',
  };

  it('targets the existing call endpoint with the identity and fixed facts of the execution', () => {
    const report = buildToolCallReport(completed(), descriptor);

    expect(report.path).toBe('/api/v1/plugins/report/call');
    expect(report.eventId).toBe('v1:call:op:tc:1');
    expect(report.body).toMatchObject({
      callDurationMs: 42,
      eventId: 'v1:call:op:tc:1',
      identifier: 'github',
      methodName: 'search',
      methodType: 'tool',
      occurredAt: '2026-10-16T08:00:00.000Z',
      success: true,
      version: '1.2.0',
    });
  });

  it('reports an unknown version as such, not as a guess', () => {
    expect(
      buildToolCallReport(completed(), { ...descriptor, version: undefined }).body,
    ).toMatchObject({ version: 'unknown' });
  });

  it('carries the failure of a failed execution', () => {
    const report = buildToolCallReport(
      completed({ errorCode: 'MCP_EXECUTION_ERROR', errorMessage: 'nope', success: false }),
      descriptor,
    );

    expect(report.body).toMatchObject({
      errorCode: 'MCP_EXECUTION_ERROR',
      errorMessage: 'nope',
      success: false,
    });
  });

  // Inputs and outputs of a tool call are the user's data. Only their sizes go.
  it('never carries what the tool was given or returned', () => {
    const report = buildToolCallReport(completed(), {
      ...descriptor,
      inputParams: { secret: 'a' },
      outputResult: { secret: 'b' },
      requestSizeBytes: 10,
      responseSizeBytes: 20,
    } as never);

    expect(report.body).not.toHaveProperty('inputParams');
    expect(report.body).not.toHaveProperty('outputResult');
    expect(report.body).toMatchObject({ requestSizeBytes: 10, responseSizeBytes: 20 });
  });

  it('keeps only flat, non-secret metadata', () => {
    const report = buildToolCallReport(completed(), {
      ...descriptor,
      appVersion: '2.0.0',
      command: 'npx',
      viaDevice: true,
    });

    expect(report.body.metadata).toEqual({
      appVersion: '2.0.0',
      command: 'npx',
      mcpType: 'cloud',
      viaDevice: true,
    });
  });

  it('is the same bytes every time it is built from the same facts', () => {
    expect(JSON.stringify(buildToolCallReport(completed(), descriptor).body)).toBe(
      JSON.stringify(buildToolCallReport(completed(), descriptor).body),
    );
  });

  it('cannot be changed after it is built', () => {
    const report = buildToolCallReport(completed(), descriptor);

    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.body)).toBe(true);
    expect(() => {
      (report.body as Record<string, unknown>).success = false;
    }).toThrow();
  });
});

describe('buildPluginInstallReport', () => {
  it('targets the install endpoint and drops the connection parameters', () => {
    const report = buildPluginInstallReport(
      completed({ eventId: 'v1:install:u1:1', eventType: 'install' }),
      {
        identifier: 'github',
        installParams: { env: { TOKEN: 'secret' } },
        manifest: { tools: [] },
        platform: 'darwin',
        version: '1.0.0',
      } as never,
    );

    expect(report.path).toBe('/api/v1/plugins/report/installation');
    expect(report.body).toMatchObject({
      eventId: 'v1:install:u1:1',
      identifier: 'github',
      installDurationMs: 42,
      manifest: { tools: [] },
      occurredAt: '2026-10-16T08:00:00.000Z',
      platform: 'darwin',
      success: true,
      version: '1.0.0',
    });
    expect(JSON.stringify(report.body)).not.toContain('secret');
    expect(report.body).not.toHaveProperty('installParams');
  });
});

describe('buildInteractionReport', () => {
  it('uses the unified endpoint with the resource type', () => {
    const report = buildInteractionReport(
      completed({ durationMs: 0, eventId: 'v1:add:u1:1', eventType: 'add' }),
      { identifier: 'my-agent', resourceType: 'agent', source: '/discover/assistant/my-agent' },
    );

    expect(report.path).toBe('/api/v1/telemetry/events');
    expect(report.body).toEqual({
      durationMs: 0,
      eventId: 'v1:add:u1:1',
      eventType: 'add',
      identifier: 'my-agent',
      occurredAt: '2026-10-16T08:00:00.000Z',
      resourceType: 'agent',
      source: '/discover/assistant/my-agent',
      success: true,
    });
  });

  it('keeps source and platform inside the wire limit', () => {
    const report = buildInteractionReport(completed({ eventType: 'click' }), {
      identifier: 'a',
      platform: 'p'.repeat(80),
      resourceType: 'plugin',
      source: 's'.repeat(80),
    });

    expect((report.body.source as string).length).toBe(50);
    expect((report.body.platform as string).length).toBe(50);
  });
});

describe('completedFromEnvelope', () => {
  it('rebuilds the fixed facts a client sent, without recomputing any of them', () => {
    const rebuilt = completedFromEnvelope('call', {
      durationMs: 12.6,
      eventId: 'v1:call:inv-1:1',
      occurredAt: '2026-10-16T08:00:00.000Z',
      success: false,
    });

    expect(rebuilt).toMatchObject({
      durationMs: 13,
      eventId: 'v1:call:inv-1:1',
      eventType: 'call',
      occurredAt: '2026-10-16T08:00:00.000Z',
      success: false,
    });
  });

  it('rejects an envelope that is not a well-formed event', () => {
    expect(() =>
      completedFromEnvelope('call', {
        durationMs: 1,
        eventId: '',
        occurredAt: '2026-10-16T08:00:00.000Z',
        success: true,
      }),
    ).toThrow();
    expect(() =>
      completedFromEnvelope('call', {
        durationMs: 1,
        eventId: 'v1:call:a:1',
        occurredAt: 'yesterday',
        success: true,
      }),
    ).toThrow();
  });
});
