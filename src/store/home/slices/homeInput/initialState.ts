export type StarterMode = 'agent' | 'group' | 'write' | 'video' | 'research' | 'image' | null;

export interface HomeInputState {
  homeInputLoading: boolean;
  /**
   * Project the next home conversation is filed under. Kept for one
   * conversation only, so it is in memory rather than persisted.
   */
  homeSelectedProjectId?: string;
  inputActiveMode: StarterMode;
}

export const initialHomeInputState: HomeInputState = {
  homeInputLoading: false,
  homeSelectedProjectId: undefined,
  inputActiveMode: null,
};
