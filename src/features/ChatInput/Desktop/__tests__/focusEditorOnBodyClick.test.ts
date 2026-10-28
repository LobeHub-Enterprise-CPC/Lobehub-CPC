import { describe, expect, it, vi } from 'vitest';

import { focusEditorOnBodyClick } from '../focusEditorOnBodyClick';

const clickOn = (target: HTMLElement) => ({ target }) as unknown as React.MouseEvent<HTMLElement>;

describe('focusEditorOnBodyClick', () => {
  const body = document.createElement('div');
  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  const line = document.createElement('p');
  editable.append(line);
  body.append(editable);

  it('focuses the editor when the empty input body is clicked', () => {
    const editor = { focus: vi.fn() };

    focusEditorOnBodyClick(editor)(clickOn(body));

    expect(editor.focus).toHaveBeenCalledTimes(1);
  });

  it('leaves clicks inside the editable text to the editor itself', () => {
    const editor = { focus: vi.fn() };

    focusEditorOnBodyClick(editor)(clickOn(line));

    expect(editor.focus).not.toHaveBeenCalled();
  });

  it('does nothing before the editor is ready', () => {
    expect(() => focusEditorOnBodyClick(undefined)(clickOn(body))).not.toThrow();
  });
});
