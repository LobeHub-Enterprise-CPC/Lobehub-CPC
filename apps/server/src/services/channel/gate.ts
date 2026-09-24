import { getChannelGatewayUrl } from './gateway';

/** Channels are enabled for everyone when a valid gateway is configured. */
export const isChannelEnabled = () => !!getChannelGatewayUrl();
