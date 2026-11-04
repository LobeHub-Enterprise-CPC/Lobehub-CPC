import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import HierarchyNodeName from './HierarchyNodeName';

describe('HierarchyNodeName', () => {
  it('keeps the serial of names that share a long prefix in its own pinned tail', () => {
    render(<HierarchyNodeName name="设计验收-1101-滚动列表-01.txt" />);

    expect(screen.getByText('动列表-01.txt')).toHaveStyle({ flex: 'none' });
  });

  it('offers the complete name however it is truncated', () => {
    render(<HierarchyNodeName name="设计验收-1101-滚动列表-01.txt" />);

    expect(screen.getByTitle('设计验收-1101-滚动列表-01.txt')).toBeInTheDocument();
  });
});
