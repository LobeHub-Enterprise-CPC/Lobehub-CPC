import { describe, expect, it, vi } from 'vitest';

import { getAppConfig } from '@/envs/app';

import { getServerDefaultAgentConfig } from './index';
import { parseAgentConfig } from './parseDefaultAgent';

vi.mock('@/envs/app', () => ({
  getAppConfig: vi.fn(),
}));

vi.mock('./parseDefaultAgent', () => ({
  parseAgentConfig: vi.fn(),
}));

describe('getServerDefaultAgentConfig', () => {
  it('should return parsed agent config', () => {
    const mockConfig = { key: 'value' };
    vi.mocked(getAppConfig).mockReturnValue({
      DEFAULT_AGENT_CONFIG: 'test_agent_config',
    } as any);
    vi.mocked(parseAgentConfig).mockReturnValue(mockConfig);

    const result = getServerDefaultAgentConfig();

    expect(parseAgentConfig).toHaveBeenCalledWith('test_agent_config');
    expect(result).toEqual(mockConfig);
  });

  it('should return empty object if parseAgentConfig returns undefined', () => {
    vi.mocked(getAppConfig).mockReturnValue({
      DEFAULT_AGENT_CONFIG: 'test_agent_config',
    } as any);
    vi.mocked(parseAgentConfig).mockReturnValue(undefined);

    const result = getServerDefaultAgentConfig();

    expect(result).toEqual({});
  });
});
