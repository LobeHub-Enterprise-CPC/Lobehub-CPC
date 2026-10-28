import { isDesktop } from '@lobechat/const';
import { TRPCError } from '@trpc/server';
import debug from 'debug';
import { z } from 'zod';

import {
  buildInteractionReport,
  buildPluginInstallReport,
  buildToolCallReport,
  completedFromEnvelope,
  type TelemetryEnvelope,
  type TelemetryEventType,
  type TelemetryReport,
  type TelemetryResourceType,
} from '@/libs/market-telemetry';
import { publicProcedure } from '@/libs/trpc/lambda';
import { marketUserInfo, serverDatabase } from '@/libs/trpc/lambda/middleware';
import { scheduleMarketTelemetry } from '@/server/services/marketTelemetry';

const log = debug('lambda-router:market:telemetry');

/**
 * Client-reported telemetry. The client's own completion boundary fixed the
 * event identity, outcome, duration and time (`src/libs/market-telemetry`); the
 * server validates them and passes them on unchanged. Who the event belongs to
 * is never taken from the request: the reporter authenticates as the session's
 * user.
 */
const marketTelemetryProcedure = publicProcedure.use(serverDatabase).use(marketUserInfo);

const eventIdentity = {
  eventId: z.string().min(1).max(255),
  occurredAt: z.string().min(1).max(40),
};

const interactionShape = {
  ...eventIdentity,
  identifier: z.string().min(1).max(255),
  source: z.string().optional(),
};

const agentInteractionInput = z.object({
  ...interactionShape,
  event: z.enum(['add', 'chat', 'click']),
});

const pluginInteractionInput = z.object({
  ...interactionShape,
  event: z.enum(['click', 'install', 'activate', 'uninstall']),
});

const countInput = z.object({ ...eventIdentity, identifier: z.string().min(1).max(255) });

const rebuild = (eventType: TelemetryEventType, envelope: TelemetryEnvelope) => {
  try {
    return completedFromEnvelope(eventType, envelope);
  } catch (error) {
    throw new TRPCError({
      cause: error,
      code: 'BAD_REQUEST',
      message: 'Invalid telemetry event identity',
    });
  }
};

interface ReportingContext {
  marketAccessToken?: string;
  serverDB?: any;
  userId?: string | null;
}

const send = (report: TelemetryReport, ctx: ReportingContext) => {
  log('Scheduling telemetry %s', report.eventId);
  scheduleMarketTelemetry(report, {
    marketAccessToken: ctx.marketAccessToken,
    serverDB: ctx.serverDB,
    userId: ctx.userId,
  });
  return { success: true };
};

const interaction =
  (resourceType: TelemetryResourceType) =>
  ({
    ctx,
    input,
  }: {
    ctx: ReportingContext;
    input: {
      event: TelemetryEventType;
      eventId: string;
      identifier: string;
      occurredAt: string;
      source?: string;
    };
  }) => {
    const completed = rebuild(input.event, {
      durationMs: 0,
      eventId: input.eventId,
      occurredAt: input.occurredAt,
      success: true,
    });

    return send(
      buildInteractionReport(completed, {
        identifier: input.identifier,
        resourceType,
        source: input.source,
      }),
      ctx,
    );
  };

const install =
  (resourceType: TelemetryResourceType) =>
  ({
    ctx,
    input,
  }: {
    ctx: ReportingContext;
    input: { eventId: string; identifier: string; occurredAt: string };
  }) =>
    send(
      buildInteractionReport(
        rebuild('install', {
          durationMs: 0,
          eventId: input.eventId,
          occurredAt: input.occurredAt,
          success: true,
        }),
        { identifier: input.identifier, resourceType },
      ),
      ctx,
    );

const asText = (value: unknown) => (typeof value === 'string' ? value : undefined);

export const telemetryProcedures = {
  reportAgentEvent: marketTelemetryProcedure
    .input(agentInteractionInput)
    .mutation(interaction('agent')),

  reportAgentInstall: marketTelemetryProcedure.input(countInput).mutation(install('agent')),

  reportCall: marketTelemetryProcedure
    .input(
      z.object({
        ...eventIdentity,
        callDurationMs: z.number().min(0),
        customPluginInfo: z
          .object({
            avatar: z.string().optional(),
            description: z.string().optional(),
            name: z.string().optional(),
          })
          .optional(),
        errorCode: z.string().max(100).optional(),
        errorMessage: z.string().optional(),
        identifier: z.string().min(1).max(255),
        isCustomPlugin: z.boolean().optional(),
        metadata: z.record(z.string(), z.any()).optional(),
        methodName: z.string(),
        methodType: z.enum(['tool', 'prompt', 'resource']),
        requestSizeBytes: z.number().optional(),
        responseSizeBytes: z.number().optional(),
        sessionId: z.string().optional(),
        success: z.boolean(),
        traceId: z.string().optional(),
        version: z.string(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const completed = rebuild('call', {
        durationMs: input.callDurationMs,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        eventId: input.eventId,
        occurredAt: input.occurredAt,
        success: input.success,
      });

      return send(
        buildToolCallReport(completed, {
          appVersion: asText(input.metadata?.appVersion),
          command: asText(input.metadata?.command),
          customPluginInfo: input.customPluginInfo,
          identifier: input.identifier,
          isCustomPlugin: input.isCustomPlugin,
          mcpType: asText(input.metadata?.mcpType),
          methodName: input.methodName,
          platform: isDesktop ? process.platform : 'web',
          requestSizeBytes: input.requestSizeBytes,
          responseSizeBytes: input.responseSizeBytes,
          sessionId: input.sessionId,
          traceId: input.traceId,
          version: input.version,
        }),
        ctx,
      );
    }),

  reportGroupAgentEvent: marketTelemetryProcedure
    .input(agentInteractionInput)
    .mutation(interaction('agentGroup')),

  reportGroupAgentInstall: marketTelemetryProcedure
    .input(countInput)
    .mutation(install('agentGroup')),

  reportMcpEvent: marketTelemetryProcedure
    .input(pluginInteractionInput)
    .mutation(interaction('plugin')),

  reportMcpInstallResult: marketTelemetryProcedure
    .input(
      z.object({
        ...eventIdentity,
        errorCode: z.string().max(100).optional(),
        errorMessage: z.string().optional(),
        identifier: z.string().min(1).max(255),
        installDurationMs: z.number().min(0).optional(),
        // Accepted so a client that still sends them is not rejected; never forwarded.
        installParams: z.any().optional(),
        manifest: z.any().optional(),
        metadata: z.record(z.string(), z.any()).optional(),
        platform: z.string().optional(),
        success: z.boolean(),
        userAgent: z.string().optional(),
        version: z.string(),
      }),
    )
    .mutation(({ ctx, input }) =>
      send(
        buildPluginInstallReport(
          rebuild('install', {
            durationMs: input.installDurationMs ?? 0,
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
            eventId: input.eventId,
            occurredAt: input.occurredAt,
            success: input.success,
          }),
          {
            identifier: input.identifier,
            manifest: input.manifest,
            metadata: input.metadata,
            platform: input.platform,
            userAgent: input.userAgent,
            version: input.version,
          },
        ),
        ctx,
      ),
    ),
};
