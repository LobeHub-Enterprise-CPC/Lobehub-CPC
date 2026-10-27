import {
  agentOperations,
  apiKeys,
  oidcClients,
  oidcGrants,
  session,
  users,
} from '@lobechat/database/schemas';

import type { LobeChatDatabase } from '@/database/type';

/** Every caller uses an isolated in-memory PGlite database. */
export const seedGatewaySourceRows = async (
  db: LobeChatDatabase,
  input: {
    tenantId: string;
    subject: string;
    operationId: string;
    sessionId: string;
    keyId: string;
    keyHash: string;
  },
) => {
  const { tenantId, subject, operationId, sessionId, keyId, keyHash } = input;
  await db.delete(agentOperations);
  await db.delete(users);
  await db.delete(oidcClients);
  await db.insert(users).values({ id: subject });
  await db.insert(session).values({
    id: sessionId,
    userId: subject,
    token: 'TEST-ONLY-SESSION',
    expiresAt: new Date(Date.now() + 3600_000),
    updatedAt: new Date(),
  });
  await db.insert(apiKeys).values({
    id: keyId,
    userId: subject,
    key: 'TEST-ONLY-CIPHERTEXT',
    keyHash,
    name: 'Gateway test',
    enabled: true,
    scopes: null,
  });
  await db.insert(oidcClients).values({
    id: 'tituwork-desktop',
    name: 'Desktop',
    redirectUris: [],
    grants: [],
    responseTypes: [],
    scopes: [],
    enabled: true,
  });
  await db.insert(oidcGrants).values({
    id: 'grant-A',
    clientId: 'tituwork-desktop',
    userId: subject,
    data: {},
    expiresAt: new Date(Date.now() + 3600_000),
  });
  await db.insert(agentOperations).values({
    id: operationId,
    userId: subject,
    status: 'running',
    metadata: { tenantId, sourceAcceptedVersion: 7 },
  });
};
