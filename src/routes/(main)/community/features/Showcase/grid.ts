import * as stylex from '@stylexjs/stylex';

export const gridStyles = stylex.create({
  // The design's list rows: three 341px cards with 16px gutters at full width.
  cards: {
    display: 'grid',
    gap: 16,
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  },
  // Four featured assistants across.
  featured: {
    display: 'grid',
    gap: 16,
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
});
