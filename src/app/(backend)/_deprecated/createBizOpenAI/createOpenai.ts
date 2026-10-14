import { ENABLE_BUSINESS_FEATURES } from '@lobechat/business-const';
import { createSsrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import { ChatErrorType } from '@lobechat/types';
import OpenAI from 'openai';

import { getLLMConfig } from '@/envs/llm';

// create OpenAI instance
export const createOpenai = (userApiKey: string | null, endpoint?: string | null) => {
  // Business builds are multi-tenant: the instance OpenAI credentials are never lent out.
  const { OPENAI_API_KEY } = ENABLE_BUSINESS_FEATURES ? {} : getLLMConfig();
  const OPENAI_PROXY_URL = ENABLE_BUSINESS_FEATURES ? undefined : process.env.OPENAI_PROXY_URL;

  const baseURL = endpoint || OPENAI_PROXY_URL || undefined;

  const apiKey = userApiKey || OPENAI_API_KEY;

  if (!apiKey) throw new Error('OPENAI_API_KEY is empty', { cause: ChatErrorType.NoOpenAIAPIKey });

  // `endpoint` comes from a request header; only the platform's OPENAI_PROXY_URL stays on the
  // plain transport.
  return new OpenAI({ apiKey, baseURL, ...(endpoint && { fetch: createSsrfSafeFetch() as any }) });
};
