/**
 * lobe-ui publishes its build under the `./es/*` entry in `exports`, but ships
 * no declaration files for the two theme algorithms. `algorithm.ts` needs them
 * to keep lobe's own token derivation in the chain while appending the brand
 * layer. If a lobe-ui upgrade moves these modules the import fails at build
 * time rather than silently dropping the library's tokens.
 */
declare module '@lobehub/ui/es/styles/theme/algorithms/lightAlgorithm' {
  import type { MapToken, SeedToken } from 'antd/es/theme/interface';

  export const lightAlgorithm: (seed: SeedToken, map?: MapToken) => MapToken;
}

declare module '@lobehub/ui/es/styles/theme/algorithms/darkAlgorithm' {
  import type { MapToken, SeedToken } from 'antd/es/theme/interface';

  export const darkAlgorithm: (seed: SeedToken, map?: MapToken) => MapToken;
}
