import { ActionIcon, cssVar, stopPropagation } from '@lobehub/ui';
import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { styles } from '../../styles';
import { useModelFavoritesContext } from './modelFavoritesContext';

interface ModelFavoriteButtonProps {
  model: string;
  /** Providers offering this row's model; starring keeps the first one. */
  providers: readonly string[];
}

/** Stars a model without selecting it: the row around it is a menu item. */
export const ModelFavoriteButton = ({ model, providers }: ModelFavoriteButtonProps) => {
  const { t } = useTranslation('components');
  const favorites = useModelFavoritesContext();
  if (!favorites) return null;

  const favorite = favorites.isFavorite(model, providers);
  const label = t(favorite ? 'ModelSwitchPanel.favorite.remove' : 'ModelSwitchPanel.favorite.add');

  return (
    <ActionIcon
      data-favorite-action
      aria-label={label}
      aria-pressed={favorite}
      className={styles.favoriteAction}
      color={favorite ? cssVar.colorWarning : undefined}
      fill={favorite ? cssVar.colorWarning : 'none'}
      icon={Star}
      size={{ blockSize: 20, size: 14 }}
      title={label}
      onMouseDown={stopPropagation}
      onPointerDown={stopPropagation}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void favorites.setFavorite(model, providers, !favorite);
      }}
    />
  );
};
