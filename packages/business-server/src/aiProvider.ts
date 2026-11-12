import { getHiddenLobeHubModelsForUser } from '@lobechat/business-model-bank/model-config';
import type { BuiltinModelIdentifier } from 'model-bank';

/**
 * Delegates to the business model-bank slot. The OSS stub returns `[]`; the
 * private build returns the branded models the user's tenant policies hide.
 * `undefined` means access could not be resolved and every builtin model must
 * be treated as hidden (fail-closed).
 */
export const getHiddenBuiltinModelsForUser = async (
  userId: string,
): Promise<BuiltinModelIdentifier[] | undefined> => getHiddenLobeHubModelsForUser(userId);

/**
 * Retired `${providerId}/${modelId}` → successor model id map. Business
 * implementations may source this from routing configuration; there is none by
 * default.
 */
export const getModelRedirects = async (): Promise<Record<string, string>> => ({});
