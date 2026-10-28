import type { MouseEvent } from 'react';

/**
 * The ChatInput body is taller than its text (a text cursor over the whole box),
 * but only the content-editable lines take focus. Clicking the blank rest of the
 * body focuses the editor; clicks on the text keep their own caret placement.
 */
export const focusEditorOnBodyClick =
  (editor: { focus: () => void } | undefined) => (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('[contenteditable="true"]')) return;
    editor?.focus();
  };
