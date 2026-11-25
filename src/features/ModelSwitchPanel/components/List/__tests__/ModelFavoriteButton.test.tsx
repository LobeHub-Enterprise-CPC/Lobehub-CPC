/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ModelFavoriteButton } from '../ModelFavoriteButton';
import { type ModelFavorites, ModelFavoritesContext } from '../modelFavoritesContext';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@lobehub/ui', () => ({
  ActionIcon: ({ color, fill, icon, size, title, ...props }: any) => <button {...props} />,
  createStaticStyles: () => ({}),
  cssVar: {},
  stopPropagation: (event: Event) => event.stopPropagation(),
}));

const renderButton = (favorites: Partial<ModelFavorites> | null) => {
  const onRowClick = vi.fn();
  render(
    <ModelFavoritesContext value={favorites as ModelFavorites | null}>
      <div onClick={onRowClick}>
        <ModelFavoriteButton model={'a'} providers={['lobehub', 'openai']} />
      </div>
    </ModelFavoritesContext>,
  );
  return onRowClick;
};

describe('ModelFavoriteButton', () => {
  it.each([
    [false, 'ModelSwitchPanel.favorite.add', 'false'],
    [true, 'ModelSwitchPanel.favorite.remove', 'true'],
  ])('flips the star (starred: %s) without selecting the row', (starred, label, pressed) => {
    const setFavorite = vi.fn(async () => {});
    const onRowClick = renderButton({ isFavorite: () => starred, setFavorite });

    const button = screen.getByRole('button', { name: label });
    expect(button.getAttribute('aria-pressed')).toBe(pressed);
    fireEvent.click(button);

    expect(setFavorite).toHaveBeenCalledWith('a', ['lobehub', 'openai'], !starred);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('renders nothing for pickers that keep no stars', () => {
    renderButton(null);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
