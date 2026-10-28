import { WechatApiClient } from '@lobechat/chat-adapter-wechat';
import { createSsrfSafeFetch } from '@lobechat/ssrf-safe-fetch';

/**
 * Transport for the iLink API host. `baseUrl` is part of the bot credentials a
 * user submits (the credentials record accepts any key), so a custom host is
 * user input and goes through the connect-time-filtered transport. Without one
 * the client talks to the default iLink host and keeps the plain transport.
 */
export const wechatApiFetch = (baseUrl?: string): typeof fetch | undefined =>
  baseUrl?.trim() ? (createSsrfSafeFetch() as unknown as typeof fetch) : undefined;

export const createWechatApiClient = (botToken: string, botId?: string, baseUrl?: string) =>
  new WechatApiClient(botToken, botId, baseUrl, { fetch: wechatApiFetch(baseUrl) });
