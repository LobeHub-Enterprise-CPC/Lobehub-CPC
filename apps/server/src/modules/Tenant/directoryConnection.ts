import type { tenantDirectory } from '@lobechat/database/platform';
import type { ClientConfig } from 'pg';

import { openDirectoryData } from '@/server/crypto/tenantKeys';

import { directorySecretAad } from './directorySecrets';

type Directory = typeof tenantDirectory.$inferSelect;
type Binding = Pick<Directory, 'database' | 'host' | 'port' | 'tls'>;

export const tenantPgConnection = (
  binding: Binding,
  credential: { username: string; password: string },
) =>
  ({
    database: binding.database,
    host: binding.host,
    port: binding.port,
    user: credential.username,
    password: credential.password,
    ssl: binding.tls.enabled
      ? {
          rejectUnauthorized: binding.tls.rejectUnauthorized,
          ...(binding.tls.ca && { ca: binding.tls.ca }),
        }
      : false,
  }) satisfies ClientConfig;

export const connectionFromDirectory = (
  directory: Binding &
    Pick<Directory, 'tenantId' | 'credentialBundleVersion' | 'runtimeSecret' | 'runtimeUsername'>,
) =>
  tenantPgConnection(directory, {
    username: directory.runtimeUsername,
    password: openDirectoryData(
      directory.runtimeSecret,
      directorySecretAad(directory.tenantId, directory.credentialBundleVersion, 'runtime'),
    ),
  });
