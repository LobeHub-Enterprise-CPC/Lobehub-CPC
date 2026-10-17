import { spawn } from 'node:child_process';

import { createSsrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type Progress } from '@modelcontextprotocol/sdk/types.js';
import debug from 'debug';

import {
  sanitizeErrorForMcp,
  sanitizeMcpParamsForLogging,
  sanitizeUrlForLogging,
} from './sanitize';
import {
  type MCPClientParams,
  type MCPError,
  type McpPrompt,
  type McpResource,
  type McpTool,
  type ToolCallResult,
} from './types';
import { createMCPError } from './types';

const log = debug('lobe-mcp:client');
// MCP tool call timeout (milliseconds), configurable via the environment variable MCP_TOOL_TIMEOUT, default is 60000
// Parse MCP_TOOL_TIMEOUT, only use if it's a valid positive number, otherwise fallback to default 60000
const MCP_TOOL_TIMEOUT = (() => {
  const val = Number(process.env.MCP_TOOL_TIMEOUT);
  return Number.isFinite(val) && val > 0 ? val : 60_000;
})();

/**
 * Pre-check stdio command to capture detailed error information
 */
async function preCheckStdioCommand(params: {
  args: string[];
  command: string;
  env?: Record<string, string>;
}): Promise<{
  error?: MCPError;
  success: boolean;
}> {
  return new Promise((resolve) => {
    log(
      'Pre-checking stdio command: %s with args: %O',
      params.command,
      sanitizeMcpParamsForLogging({ args: params.args }),
    );

    // Do NOT spread the full process.env here: it would leak server-side secrets
    // (DATABASE_URL, KEY_VAULTS_SECRET, provider API keys, OAuth/JWT secrets, ...)
    // into the spawned MCP subprocess. Match the main StdioClientTransport below,
    // which only exposes the safe default environment plus user-configured vars.
    // The cast is required because this repo augments NodeJS.ProcessEnv with
    // required app keys that a restricted env intentionally omits.
    const env = {
      ...getDefaultEnvironment(),
      ...params.env,
    } as NodeJS.ProcessEnv;

    const child = spawn(params.command, params.args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    // Set timeout (5 seconds)
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGTERM');
        resolve({
          error: createMCPError('INITIALIZATION_TIMEOUT', 'MCP service initialization timeout', {
            errorLog: stderr || 'No stderr output',
            params: {
              args: params.args,
              command: params.command,
            },
            step: 'precheck_timeout',
          }),
          success: false,
        });
      }
    }, 5000);

    // Collect stdout
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    // Collect stderr - this is the critical part
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
      log('Captured stderr: %s', data.toString());
    });

    child.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        log('Process spawn error: %O', error);
        resolve({
          error: createMCPError('PROCESS_SPAWN_ERROR', 'Failed to start MCP service process', {
            originalError: error.message,
            params: {
              args: params.args,
              command: params.command,
            },
            step: 'process_spawn',
          }),
          success: false,
        });
      }
    });

    child.on('exit', (code, signal) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);

        if (code === 0) {
          log('Pre-check successful, stdout: %s', stdout);
          resolve({ success: true });
        } else {
          log('Pre-check failed with code: %d, stderr: %s', code, stderr);
          resolve({
            error: createMCPError('CONNECTION_FAILED', 'MCP service startup failed', {
              errorLog: stderr,
              params: {
                args: params.args,
                command: params.command,
              },
              process: {
                exitCode: code || undefined,
                signal: signal || undefined,
              },
              step: 'process_exit',
            }),
            success: false,
          });
        }
      }
    });

    // Send a simple JSON-RPC initialization message to test the connection
    try {
      const initMessage =
        JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            clientInfo: { name: 'lobe-mcp-precheck', version: '1.0.0' },
            protocolVersion: '2024-11-05',
          },
        }) + '\n';

      child.stdin?.write(initMessage);
      child.stdin?.end();
    } catch (writeError) {
      log('Failed to write to stdin: %O', writeError);
    }
  });
}

export class MCPClient {
  private mcp: Client;
  private transport: Transport;
  private params: MCPClientParams;

  constructor(params: MCPClientParams) {
    this.params = params;
    this.mcp = new Client({ name: 'lobehub-mcp-client', version: '1.0.0' });

    switch (params.type) {
      case 'http': {
        log('Using HTTP transport with url: %s', sanitizeUrlForLogging(params.url));

        // Build headers, including custom headers and authentication information
        const headers: Record<string, string> = { ...params.headers };

        // Handle authentication configuration
        if (params.auth) {
          switch (params.auth.type) {
            case 'bearer': {
              if (params.auth.token) {
                headers['Authorization'] = `Bearer ${params.auth.token}`;
                log('Added Bearer token authentication');
              }
              break;
            }
            case 'oauth2': {
              if (params.auth.accessToken) {
                headers['Authorization'] = `Bearer ${params.auth.accessToken}`;
                log('Added OAuth2 access token authentication');
              }
              break;
            }

            default: {
              // No authentication required
              break;
            }
          }
        }

        // Create StreamableHTTPClientTransport and pass headers
        // The MCP server URL is typed in by users, so every request (including the SSE
        // stream and redirects) goes through the connect-time-filtered transport.
        this.transport = new StreamableHTTPClientTransport(new URL(params.url), {
          fetch: createSsrfSafeFetch(),
          requestInit: { headers },
        });

        log('HTTP transport created with headers: %O', Object.keys(headers));

        break;
      }

      case 'stdio': {
        log(
          'Using Stdio transport with command: %s , args: %O',
          params.command,
          sanitizeMcpParamsForLogging({ args: params.args }),
        );

        this.transport = new StdioClientTransport({
          args: params.args,
          command: params.command,
          env: {
            ...getDefaultEnvironment(),
            ...params.env,
          },
        });
        break;
      }

      default: {
        const err = createMCPError(
          'VALIDATION_ERROR',
          `Unsupported MCP connection type: ${(params as any).type}`,
          {
            params: { type: (params as any).type },
          },
        );
        log('Error creating client: %O', err);
        throw err;
      }
    }
  }

  async initialize(options: { onProgress?: (progress: Progress) => void } = {}) {
    log('Initializing MCP connection...');

    try {
      await this.mcp.connect(this.transport, { onprogress: options.onProgress });
      log('MCP connection initialized.');
    } catch (e) {
      // Connection errors echo the request URL (userinfo / query-string keys) and
      // sometimes header values. Everything logged or rethrown below is derived
      // from this sanitized copy; the raw error is only used for control flow.
      const safe = this.redactError(e);
      log('MCP connection failed:', safe);

      if (this.params.type === 'http') {
        if (safe.message.includes('401')) throw createMCPError('AUTHORIZATION_ERROR', safe.message);

        throw safe;
      }

      const safeParams = {
        args: (sanitizeMcpParamsForLogging({ args: this.params.args }) as { args: string[] }).args,
        command: this.params.command,
        type: this.params.type,
      };

      // For stdio connection failure, attempt to pre-check command to get detailed error information
      if (this.params.type === 'stdio') {
        log('Attempting to pre-check stdio command for detailed error information...');

        const preCheckResult = await preCheckStdioCommand({
          args: this.params.args,
          command: this.params.command,
          env: this.params.env,
        });

        if (!preCheckResult.success && preCheckResult.error) {
          const safePreCheck = this.redactError(preCheckResult.error);
          log('Detailed error captured: %O', safePreCheck);
          throw safePreCheck;
        }
      }

      // For other connection types or when pre-check doesn't provide more information
      if ((e as any).code === -32_000) {
        throw createMCPError(
          'CONNECTION_FAILED',
          'Failed to connect to MCP server, please check your configuration',
          {
            originalError: safe.message,
            params: safeParams,
            step: 'mcp_connect',
          },
        );
      }

      // Wrap other unknown errors
      throw createMCPError('UNKNOWN_ERROR', safe.message, {
        originalError: safe.message,
        params: safeParams,
        step: 'mcp_connect',
      });
    }
  }

  async disconnect() {
    log('Disconnecting MCP connection...');
    // Assuming the mcp client has a disconnect method
    if (this.mcp && typeof (this.mcp as any).disconnect === 'function') {
      await (this.mcp as any).disconnect();
      log('MCP connection disconnected.');
    } else {
      log('MCP client does not have a disconnect method or is not initialized.');
      // Depending on the transport, we might need specific cleanup
      if (this.transport && typeof (this.transport as any).close === 'function') {
        (this.transport as any).close();
        log('Transport closed.');
      }
    }
  }

  /** Log-safe copy of an error for this client's params (see `sanitizeErrorForMcp`). */
  private redactError(e: unknown): Error {
    return sanitizeErrorForMcp(e, this.params);
  }

  /**
   * Detect the StreamableHTTP "session expired" error.
   *
   * Happens when the remote MCP server restarts: the cached client still sends
   * the old session id and the server rejects it with `-32000 / No valid
   * session ID provided`. Callers (e.g. MCPService) surface this as a dedicated
   * `NoValidSessionId` error and retry with a freshly-initialized session.
   */
  private static isNoValidSessionError(e: unknown): boolean {
    return e instanceof Error && e.message.includes('No valid session ID provided');
  }

  async listTools() {
    try {
      log('Listing tools...');
      const { tools } = await this.mcp.listTools();
      log('Listed tools: %O', tools);
      return tools as McpTool[];
    } catch (e) {
      console.error('Listed tools error: %O', this.redactError(e));

      if (MCPClient.isNoValidSessionError(e)) {
        // eslint-disable-next-line preserve-caught-error -- the cause is the sanitized copy on purpose
        throw new Error('NoValidSessionId', { cause: this.redactError(e) });
      }

      return [];
    }
  }

  async listResources() {
    try {
      log('Listing resources...');
      const { resources } = await this.mcp.listResources();
      log('Listed resources: %O', resources);
      return resources as McpResource[];
    } catch (e) {
      log('Listed resources: %O', this.redactError(e));

      if (MCPClient.isNoValidSessionError(e)) {
        // eslint-disable-next-line preserve-caught-error -- the cause is the sanitized copy on purpose
        throw new Error('NoValidSessionId', { cause: this.redactError(e) });
      }

      return [];
    }
  }

  async listPrompts() {
    try {
      log('Listing prompts...');
      const { prompts } = await this.mcp.listPrompts();
      log('Listed prompts: %O', prompts);
      return prompts as McpPrompt[];
    } catch (e) {
      log('Listed prompts: %O', this.redactError(e));

      if (MCPClient.isNoValidSessionError(e)) {
        // eslint-disable-next-line preserve-caught-error -- the cause is the sanitized copy on purpose
        throw new Error('NoValidSessionId', { cause: this.redactError(e) });
      }

      return [];
    }
  }

  async listManifests() {
    const capabilities = this.mcp.getServerCapabilities();
    log('get capabilities: %O', capabilities);

    const [tools, prompts, resources] = await Promise.all([
      this.listTools(),
      this.listPrompts(),
      this.listResources(),
    ]);

    const manifest = {
      prompts: prompts.length === 0 ? undefined : prompts,
      resources: resources.length === 0 ? undefined : resources,
      title: this.mcp.getServerVersion()?.title,
      tools: tools.length === 0 ? undefined : tools,
      version: this.mcp.getServerVersion()?.version?.replace('v', ''),
    };

    log('Listed Manifest: %O', manifest);

    return manifest;
  }

  async callTool(toolName: string, args: any): Promise<ToolCallResult> {
    log('Calling tool: %s with args: %O, timeout: %O', toolName, args, MCP_TOOL_TIMEOUT);
    try {
      const result = await this.mcp.callTool({ arguments: args, name: toolName }, undefined, {
        timeout: MCP_TOOL_TIMEOUT,
      });
      log('Tool call result: %O', result);
      return result as ToolCallResult;
    } catch (e) {
      // The server rejects the request before executing the tool, so retrying
      // with a fresh session is safe (no double side effects).
      if (MCPClient.isNoValidSessionError(e)) {
        // eslint-disable-next-line preserve-caught-error -- the cause is the sanitized copy on purpose
        throw new Error('NoValidSessionId', { cause: this.redactError(e) });
      }
      throw e;
    }
  }
}
