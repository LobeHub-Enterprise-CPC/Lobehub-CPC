import { vi } from 'vitest';

// Tenant schema initialization needs headroom when server suites share CPU with other workers.
vi.setConfig({ hookTimeout: 30_000, testTimeout: 15_000 });
