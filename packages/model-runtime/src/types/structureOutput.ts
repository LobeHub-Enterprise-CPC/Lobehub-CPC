import type { ModelUsage } from '@lobechat/types';

import type { ChatCompletionTool, ChatStreamPayload } from './chat';
import type { ModelPricingContext } from './pricing';

interface GenerateObjectMessage {
  content: string;
  name?: string;
  role: 'user' | 'system' | 'assistant';
}

export interface GenerateObjectSchema {
  description?: string;
  name: string;
  schema: {
    additionalProperties?: boolean;
    properties: Record<string, any>;
    required?: string[];
    type: 'object';
  };
  strict?: boolean;
}

export interface GenerateObjectPayload {
  messages: GenerateObjectMessage[];
  model: string;
  reasoning_effort?: ChatStreamPayload['reasoning_effort'];
  responseApi?: boolean;
  schema?: GenerateObjectSchema;
  /**
   * Stream the reply and assemble the object from it. For long generations behind a gateway
   * that closes connections idle past its read timeout; providers without a streaming
   * structured-output path ignore it.
   */
  stream?: boolean;
  thinking?: ChatStreamPayload['thinking'];
  tools?: ChatCompletionTool[];
}

export interface GenerateObjectOptions {
  /**
   * response headers
   */
  headers?: Record<string, any>;

  /** Free-form context passed to hooks (e.g. billing, routing). */
  metadata?: Record<string, unknown>;

  onUsage?: (usage: ModelUsage) => void | Promise<void>;

  /** Request-scoped pricing context for model-bank pricing lookups. */
  pricingContext?: ModelPricingContext;

  signal?: AbortSignal;
  /**
   * Structured tracing config consumed by tracing hooks (e.g.
   * `llm_generation_tracing`). Loosely typed here so the runtime stays
   * tracing-agnostic; callers should import `TracingOptions` from
   * `@lobechat/llm-generation-tracing` for the strongly-typed shape.
   */
  tracing?: Record<string, unknown>;

  /**
   * userId for the GenerateObject
   */
  user?: string;
}
