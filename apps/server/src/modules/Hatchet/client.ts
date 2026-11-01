import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';

let client: HatchetClient | undefined;

/**
 * The process-wide Hatchet client, built on first use from the SDK's own
 * HATCHET_CLIENT_* variables (token, host port, API URL, TLS strategy, gRPC
 * message limits). Scheduling, schedule deletion, worker pause and run queries
 * go through the REST API, so HATCHET_CLIENT_API_URL must be set as well.
 */
export const getHatchetClient = (): HatchetClient => (client ??= HatchetClient.init());
