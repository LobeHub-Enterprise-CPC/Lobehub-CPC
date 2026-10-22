export const directorySecretAad = (
  tenantId: string,
  credentialBundleVersion: number,
  role: 'owner' | 'runtime',
) => `${tenantId}|lobehub|${credentialBundleVersion}|${role}`;
