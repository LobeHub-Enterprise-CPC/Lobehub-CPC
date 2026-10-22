import {
  GetStreamableMcpServerManifestInputSchema,
  StreamableHTTPAuthSchema,
} from '@lobechat/types';
import { z } from 'zod';

import {
  requireWorkspaceRoleWhenScoped,
  wsCompatProcedure,
} from '@/business/server/trpc-middlewares/workspaceAuth';
import { ConnectorModel } from '@/database/models/connector';
import { ConnectorToolModel } from '@/database/models/connectorTool';
import { ConnectorToolPermission } from '@/database/schemas';
import { type ToolCallContent } from '@/libs/mcp';
import { router } from '@/libs/trpc/lambda';
import { serverDatabase, telemetry } from '@/libs/trpc/lambda/middleware';
import { FileService } from '@/server/services/file';
import { mcpService } from '@/server/services/mcp';
import { processContentBlocks } from '@/server/services/mcp/contentProcessor';

import { beginToolCallReport } from './_helpers';

// Define Zod schemas for MCP Client parameters
const httpParamsSchema = z.object({
  auth: StreamableHTTPAuthSchema,
  headers: z.record(z.string(), z.string()).optional(),
  name: z.string().min(1),
  type: z.literal('http'),
  url: z.string().url(),
});

const stdioParamsSchema = z.object({
  args: z.array(z.string()).optional().default([]),
  command: z.string().min(1),
  name: z.string().min(1),
  type: z.literal('stdio'),
});

// Union schema for MCPClientParams
const mcpClientParamsSchema = z.union([httpParamsSchema, stdioParamsSchema]);

// Schema for metadata that frontend needs to pass (fields that backend cannot determine)
const metaSchema = z
  .object({
    // Custom plugin info (only for custom plugins)
    customPluginInfo: z
      .object({
        avatar: z.string().optional(),
        description: z.string().optional(),
        name: z.string().optional(),
      })
      .optional(),
    // The client's id for this invocation, kept across transport retries
    executionId: z.string().min(1).max(200).optional(),
    // Whether this is a custom plugin
    isCustomPlugin: z.boolean().optional(),
    // Session/topic ID
    sessionId: z.string().optional(),
    // Plugin manifest version
    version: z.string().optional(),
  })
  .optional();

const mcpProcedure = wsCompatProcedure
  .use(serverDatabase)
  .use(telemetry)
  .use(async ({ ctx, next }) => {
    return next({
      ctx: {
        fileService: new FileService(ctx.serverDB, ctx.userId, ctx.workspaceId ?? undefined),
      },
    });
  });

export const mcpRouter = router({
  getStreamableMcpServerManifest: mcpProcedure
    .input(GetStreamableMcpServerManifestInputSchema)
    .mutation(async ({ input }) => {
      return await mcpService.getStreamableMcpServerManifest(
        input.identifier,
        input.url,
        input.metadata,
        input.auth,
        input.headers,
      );
    }),
  // --- MCP Interaction ---
  // listTools now accepts MCPClientParams directly
  listTools: mcpProcedure
    .input(mcpClientParamsSchema) // Use the unified schema
    .mutation(async ({ input }) => {
      // Stdio check can be done here or rely on the service/client layer
      checkStdioEnvironment(input);

      // Pass the validated MCPClientParams to the service
      return await mcpService.listTools(input);
    }),

  // listResources now accepts MCPClientParams directly
  listResources: mcpProcedure
    .input(mcpClientParamsSchema) // Use the unified schema
    .mutation(async ({ input }) => {
      // Stdio check can be done here or rely on the service/client layer
      checkStdioEnvironment(input);

      // Pass the validated MCPClientParams to the service
      return await mcpService.listResources(input);
    }),

  // listPrompts now accepts MCPClientParams directly
  listPrompts: mcpProcedure
    .input(mcpClientParamsSchema) // Use the unified schema
    .mutation(async ({ input }) => {
      // Stdio check can be done here or rely on the service/client layer
      checkStdioEnvironment(input);

      // Pass the validated MCPClientParams to the service
      return await mcpService.listPrompts(input);
    }),

  // callTool now accepts MCPClientParams, toolName, and args
  callTool: mcpProcedure
    // Executes tools with side effects — workspace viewers are read-only.
    .use(requireWorkspaceRoleWhenScoped('member'))
    .input(
      z.object({
        args: z.any(), // Arguments for the tool call
        meta: metaSchema, // Optional metadata for reporting
        params: mcpClientParamsSchema, // Use the unified schema for client params
        toolName: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // The execution has its identity (connector, tool, the client's invocation
      // id) as soon as the request is in, so the boundary starts here: a call
      // refused below is an execution that failed and is reported as one.
      const telemetry = beginToolCallReport({
        context: ctx,
        identifier: input.params.name,
        mcpType: input.params.type,
        meta: input.meta,
        requestPayload: input.args,
        toolName: input.toolName,
      });
      // ── Connector tool permission gate ────────────────────────────────────
      // If the connector identifier matches a user_connectors entry, check whether
      // this specific tool has been disabled by the user. Disabled tools are still
      // present in the AI manifest (so the AI knows they exist) but are hard-blocked
      // here at execution time so the MCP server is never actually called.
      const connectorId = input.params.name;
      if (connectorId && ctx.userId) {
        const wsId = ctx.workspaceId ?? undefined;
        const connectorModel = new ConnectorModel(ctx.serverDB, ctx.userId, wsId);
        const [connector] = await connectorModel.queryByIdentifiers([connectorId]);
        if (connector) {
          const connectorToolModel = new ConnectorToolModel(ctx.serverDB, ctx.userId, wsId);
          const tools = await connectorToolModel.queryByConnector(connector.id);
          const tool = tools.find((t) => t.toolName === input.toolName);
          if (tool?.permission === ConnectorToolPermission.disabled) {
            return {
              content:
                `The tool "${input.toolName}" has been disabled by the user and cannot be executed. ` +
                `Please inform the user that this tool is currently disabled. ` +
                `They can re-enable it in Settings > Connectors.`,
              state: {
                content: [
                  {
                    text:
                      `The tool "${input.toolName}" has been disabled by the user and cannot be executed. ` +
                      `Please inform the user that this tool is currently disabled. ` +
                      `They can re-enable it in Settings > Connectors.`,
                    type: 'text',
                  },
                ],
                isError: false,
              },
              success: true,
            };
          }
        }
      }
      // ── End permission gate ───────────────────────────────────────────────

      const startTime = Date.now();
      const success = true;
      let errorCode: string | undefined;
      let errorMessage: string | undefined;
      let result: Awaited<ReturnType<typeof mcpService.callTool>> | undefined;
      let thrown: unknown;

      try {
        // Stdio check can be done here or rely on the service/client layer
        checkStdioEnvironment(input.params);

        // ── Connector tool permission gate ──────────────────────────────────
        // If the connector identifier matches a user_connectors entry, check whether
        // this specific tool has been disabled by the user. Disabled tools are still
        // present in the AI manifest (so the AI knows they exist) but are hard-blocked
        // here at execution time so the MCP server is never actually called.
        const connectorId = input.params.name;
        if (connectorId && ctx.userId) {
          const wsId = ctx.workspaceId ?? undefined;
          const connectorModel = new ConnectorModel(ctx.serverDB, ctx.userId, wsId);
          const [connector] = await connectorModel.queryByIdentifiers([connectorId]);
          if (connector) {
            const connectorToolModel = new ConnectorToolModel(ctx.serverDB, ctx.userId, wsId);
            const tools = await connectorToolModel.queryByConnector(connector.id);
            const tool = tools.find((t) => t.toolName === input.toolName);
            if (tool?.permission === ConnectorToolPermission.disabled) {
              // The response below is a success for the caller (the model is
              // told to relay it); as an execution it did not run.
              telemetry.complete({
                errorCode: 'TOOL_DISABLED',
                errorMessage: 'The tool is disabled by the user',
                success: false,
              });
              return {
                content:
                  `The tool "${input.toolName}" has been disabled by the user and cannot be executed. ` +
                  `Please inform the user that this tool is currently disabled. ` +
                  `They can re-enable it in Settings > Connectors.`,
                state: {
                  content: [
                    {
                      text:
                        `The tool "${input.toolName}" has been disabled by the user and cannot be executed. ` +
                        `Please inform the user that this tool is currently disabled. ` +
                        `They can re-enable it in Settings > Connectors.`,
                      type: 'text',
                    },
                  ],
                  isError: false,
                },
                success: true,
              };
            }
          }
        }
        // ── End permission gate ─────────────────────────────────────────────

        // Create a closure that binds fileService and userId to processContentBlocks
        const boundProcessContentBlocks = async (blocks: ToolCallContent[]) => {
          return processContentBlocks(blocks, ctx.fileService);
        };

        // Pass the validated params, toolName, args, and bound processContentBlocks to the service
        result = await mcpService.callTool({
          argsStr: input.args,
          clientParams: input.params,
          processContentBlocks: boundProcessContentBlocks,
          toolName: input.toolName,
        });

        return result;
      } catch (error) {
        thrown = error;
        throw error;
      } finally {
        // A result that says it is an error counts as one, as does a throw.
        // The first completion wins, so the refusal above keeps its own outcome.
        telemetry.complete({ result, thrown });
      }
    }),
});
