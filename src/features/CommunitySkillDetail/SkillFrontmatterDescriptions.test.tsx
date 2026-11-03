// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SkillFrontmatterDescriptions from './SkillFrontmatterDescriptions';

describe('SkillFrontmatterDescriptions', () => {
  it('lists each frontmatter field as a label and its value', () => {
    const { container } = render(
      <SkillFrontmatterDescriptions
        frontmatter={`name: minimax-xlsx
description: "Open, create, read Excel files."
license: MIT
metadata:
  version: "1.0"
  category: productivity`}
      />,
    );

    expect(container.querySelectorAll('dt')).toHaveLength(4);
    expect(screen.getByText('name')).toBeTruthy();
    expect(screen.getByText('minimax-xlsx')).toBeTruthy();
    expect(screen.getByText('Open, create, read Excel files.')).toBeTruthy();
    expect(screen.getByText('MIT')).toBeTruthy();
    expect(container.textContent).toContain('version: "1.0"');
    expect(container.textContent).toContain('category: productivity');
  });

  it('falls back to the raw YAML when it cannot be read as fields', () => {
    const { container } = render(<SkillFrontmatterDescriptions frontmatter={'[unclosed'} />);

    expect(container.querySelectorAll('dt')).toHaveLength(0);
    expect(container.textContent).toContain('[unclosed');
  });
});
