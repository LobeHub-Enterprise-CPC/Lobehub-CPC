import { createContext, useContext } from 'react';

export interface ModelFavorites {
  /** Starred models as `provider/model`, in the order they were starred. */
  favorites: readonly string[];
  /** Whether any of these providers' offer of the model is starred. */
  isFavorite: (model: string, providers: readonly string[]) => boolean;
  /** Stars the first provider's offer of the model, or clears the star from all of them. */
  setFavorite: (model: string, providers: readonly string[], favorite: boolean) => Promise<void>;
}

/** Set by the list; rows rendered without it (image and video pickers) have no star. */
export const ModelFavoritesContext = createContext<ModelFavorites | null>(null);

export const useModelFavoritesContext = () => useContext(ModelFavoritesContext);
