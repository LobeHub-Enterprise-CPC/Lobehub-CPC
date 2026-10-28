import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ImageLayout from './index';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), showAiImage: true }));
vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => mocks.navigate,
}));
vi.mock('@/store/serverConfig', () => ({
  featureFlagsSelectors: (state: unknown) => state,
  useServerConfigStore: () => ({ showAiImage: mocks.showAiImage }),
}));
vi.mock('@/store/image', () => ({ useImageStore: vi.fn() }));
vi.mock('@/routes/(main)/(create)/features/GenerationLayout', () => ({
  default: () => <div>image layout</div>,
}));
vi.mock('./RegisterHotkeys', () => ({ default: () => null }));
vi.mock('./Sidebar', () => ({ default: () => null }));

describe('image route flag boundary', () => {
  it('redirects disabled image routes to video without mounting image controls', () => {
    mocks.showAiImage = false;
    render(<ImageLayout />);
    expect(screen.queryByText('image layout')).not.toBeInTheDocument();
    expect(mocks.navigate).toHaveBeenCalledWith('/video', { replace: true });
  });

  it('keeps enabled image routes available', () => {
    mocks.showAiImage = true;
    mocks.navigate.mockClear();
    render(<ImageLayout />);
    expect(screen.getByText('image layout')).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
