import { isHatchetDeliveryEnabled } from './config';
import { LocalPublisher } from './localPublisher';
import { type DirectPublishRequest, HatchetPublisher } from './publisher';

/** What direct publishers need: `HatchetPublisher` in queue mode, `LocalPublisher` otherwise. */
export interface DirectDeliveryClient {
  messages: { delete: (messageId: string) => Promise<void> };
  publishJSON: (request: DirectPublishRequest) => Promise<{ messageId: string }>;
}

let hatchet: HatchetPublisher | undefined;
let local: LocalPublisher | undefined;

/**
 * The client for one-off deliveries to our own routes and to webhooks: durable
 * Hatchet deliveries in queue mode, in-process deliveries in local mode.
 */
export const getDirectDeliveryClient = (): DirectDeliveryClient =>
  isHatchetDeliveryEnabled()
    ? (hatchet ??= new HatchetPublisher())
    : (local ??= new LocalPublisher());
