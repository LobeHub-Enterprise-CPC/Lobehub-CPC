import { isEnterpriseKnowledgeEnabled } from '@lobechat/business-knowledge';

import { fileEnv } from '@/envs/file';

/**
 * Whether stored objects are public-read. Never with enterprise knowledge bases:
 * a public object bypasses every application-level read check (the authenticated
 * file proxy, library revocation), so S3_SET_ACL cannot apply there.
 */
export const publicReadObjects = () => fileEnv.S3_SET_ACL && !isEnterpriseKnowledgeEnabled();
