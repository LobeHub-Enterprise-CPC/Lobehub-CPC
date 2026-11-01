import { qstashClient } from '@/libs/qstash';

import { isHatchetDeliveryEnabled } from './config';
import { type DirectPublishRequest, HatchetPublisher } from './publisher';

/** What direct publishers use of a QStash client; the QStash client and `HatchetPublisher` both fit. */
export interface DirectDeliveryClient {
  messages: { delete: (messageId: string) => Promise<void> };
  publishJSON: (request: DirectPublishRequest) => Promise<{ messageId: string }>;
}

let publisher: HatchetPublisher | undefined;

/**
 * The client for one-off deliveries to our own routes and to webhooks:
 * Hatchet in Hatchet delivery mode, the shared QStash client otherwise.
 * Upstash Workflow triggers keep using QStash directly.
 */
export const getDirectDeliveryClient = (): DirectDeliveryClient =>
  isHatchetDeliveryEnabled() ? (publisher ??= new HatchetPublisher()) : qstashClient;
