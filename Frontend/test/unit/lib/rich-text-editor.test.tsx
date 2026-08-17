import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RichTextEditor } from '@/lib/rich-text-editor';

// jsdom ships none of these, and ProseMirror (TipTap's engine) reads Range
// geometry on every transaction.
beforeAll(() => {
  const emptyRect = () =>
    ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;
  Range.prototype.getBoundingClientRect ??= emptyRect;
  Range.prototype.getClientRects ??= () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  document.elementFromPoint ??= () => null;
});

afterEach(() => {
  cleanup();
});

const editorEl = () => screen.getByLabelText('Email Message');
const button = (name: RegExp) => screen.getByRole('button', { name });

async function renderEditor(value = '', onChange = vi.fn()) {
  const view = render(
    <RichTextEditor
      id="invoice-email-message"
      ariaLabel="Email Message"
      value={value}
      onChange={onChange}
    />
  );
  await waitFor(() => expect(editorEl()).toHaveAttribute('contenteditable', 'true'));
  return { ...view, onChange };
}

describe('RichTextEditor', () => {
  it('exposes the editor as a multiline textbox, not a bare div', async () => {
    // <Label htmlFor> cannot bind to a contenteditable div, so the editor has
    // to carry its own role and name.
    await renderEditor('<p>Hello</p>');

    expect(editorEl()).toHaveAttribute('role', 'textbox');
    expect(editorEl()).toHaveAttribute('aria-multiline', 'true');
  });

  it('reports an emptied editor as the empty string, not <p></p>', async () => {
    // The settings API stores '' for "no message"; TipTap's empty document is
    // one empty paragraph, and the two must map onto each other.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onChange } = await renderEditor('<p>Hello</p>');

    await user.click(editorEl());
    await user.keyboard('{Control>}a{/Control}{Backspace}');

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('lets a parent-driven value change reach the DOM', async () => {
    const { rerender, onChange } = await renderEditor('<p>Hello</p>');

    rerender(
      <RichTextEditor
        id="invoice-email-message"
        ariaLabel="Email Message"
        value="<p>Replaced</p>"
        onChange={onChange}
      />
    );

    await waitFor(() => expect(editorEl()).toHaveTextContent('Replaced'));
  });

  it('does not echo a parent-driven value back through onChange', async () => {
    // setContent emits an update by default in TipTap v3, which would turn the
    // settings load into a render side effect that dirties the form — and
    // would silently rewrite any stored value ProseMirror normalises.
    const { rerender, onChange } = await renderEditor('<p>Hello</p>');
    onChange.mockClear();

    rerender(
      <RichTextEditor
        id="invoice-email-message"
        ariaLabel="Email Message"
        value="<p>Replaced</p>"
        onChange={onChange}
      />
    );

    await waitFor(() => expect(editorEl()).toHaveTextContent('Replaced'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves a legacy plain-text message untouched until the user edits it', async () => {
    // Email Message was a textarea two commits ago, so stored values may be
    // plain text, and they arrive the way the panel's settings GET does: an
    // external value change after mount. Displaying one must not rewrite it to
    // <p>…</p> behind the user's back — conversion happens on a real edit, not
    // on opening the tab.
    const { rerender, onChange } = await renderEditor('');

    rerender(
      <RichTextEditor
        id="invoice-email-message"
        ariaLabel="Email Message"
        value="Hello plain text"
        onChange={onChange}
      />
    );

    await waitFor(() => expect(editorEl()).toHaveTextContent('Hello plain text'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not turn a markdown shortcut into a heading', async () => {
    // StarterKit ships heading, blockquote, code and code block, none of which
    // the toolbar exposes and none of which the email template styles — but
    // all of which markdown input rules reach from the keyboard. Typing '# '
    // must stay literal, or the user silently sends unstyled markup.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onChange } = await renderEditor('');

    await user.click(editorEl());
    await user.keyboard('# Heading');

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(editorEl().querySelector('h1')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith('<p># Heading</p>');
  });

  describe.each([
    ['Bold', /^bold$/i],
    ['Italic', /^italic$/i],
    ['Bullet list', /bullet list/i],
    ['Numbered list', /numbered list/i],
  ])('the %s control', (_label, name) => {
    it('toggles from a mouse click', async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await renderEditor('<p>Hello</p>');

      await user.click(editorEl());
      await user.click(button(name));

      await waitFor(() =>
        expect(button(name)).toHaveAttribute('aria-pressed', 'true')
      );
    });

    it('toggles from a keyboard activation', async () => {
      // A focused button activated by Enter dispatches click and never
      // mousedown, so wiring the action to mousedown alone leaves every
      // control tabbable and inert.
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await renderEditor('<p>Hello</p>');

      await user.click(editorEl());
      button(name).focus();
      await user.keyboard('{Enter}');

      await waitFor(() =>
        expect(button(name)).toHaveAttribute('aria-pressed', 'true')
      );
    });
  });
});
