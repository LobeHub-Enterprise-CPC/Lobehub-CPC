import type { AiFullModelCard, AiModelType, BuiltinModelIdentifier } from 'model-bank';
import { loadModels as loadModelBankModels, ModelProvider } from 'model-bank';

interface LobeHubModelConfig {
  models: AiFullModelCard[];
  planCardModels: string[];
  updatedAt?: string;
  version: number;
}

export interface LobeHubModelPricingContext {
  plan: string;
  scope: 'personal';
}

export interface LobeHubModelPricingOptions {
  pricingContext?: LobeHubModelPricingContext;
}

const getDefaultLobeHubModelConfig = (): LobeHubModelConfig => ({
  models: [],
  planCardModels: [],
  version: 1,
});

const loadLobeHubModelConfig = async (): Promise<LobeHubModelConfig> =>
  getDefaultLobeHubModelConfig();

export const loadModels = async (_options?: LobeHubModelPricingOptions) =>
  loadModelBankModels({
    providerLoaders: {
      [ModelProvider.LobeHub]: loadLobeHubModels,
    },
  });

const loadLobeHubModels = async (): Promise<AiFullModelCard[]> =>
  (await loadLobeHubModelConfig()).models;

export const loadLobeHubPlanCardModels = async (): Promise<string[]> =>
  (await loadLobeHubModelConfig()).planCardModels;

export const isLobeHubModelAvailable = (
  _id: string,
  _expectedType: AiModelType,
  _options?: {
    getUserEmail?: () => Promise<string | null | undefined>;
    trigger?: string;
    userEmail?: string | null;
    userId?: string | null;
  },
): boolean => false;

/**
 * OSS has no tenant model-access policies, so no builtin model is hidden by
 * user. Business builds replace this module and return the actual hidden set;
 * `undefined` means the access decision could not be resolved.
 */
export const getHiddenLobeHubModelsForUser = async (
  _userId: string,
): Promise<BuiltinModelIdentifier[] | undefined> => [];
