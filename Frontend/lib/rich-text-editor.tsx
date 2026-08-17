"use client";

import { useEffect } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Italic, List, ListOrdered } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * TipTap represents a cleared editor as one empty paragraph, while the
 * settings API stores '' for "no message" — the two must map onto each other
 * or every visit to the tab would dirty the form.
 */
function toStoredValue(html: string): string {
  return html === "<p></p>" ? "" : html;
}

/**
 * Only the marks and nodes the four-button toolbar drives. The rest of
 * StarterKit stays reachable from the keyboard even with no button — markdown
 * input rules give headings (`# `), blockquotes (`> `) and code blocks
 * (` ``` `), Ctrl+U gives underline — and the email template styles none of it,
 * so it reaches a customer's inbox as markup nobody chose. Undo/redo, hard
 * breaks, cursors and the list keymap stay on: editing behaviour, not output.
 */
const EMAIL_STARTER_KIT = StarterKit.configure({
  heading: false,
  blockquote: false,
  codeBlock: false,
  code: false,
  horizontalRule: false,
  strike: false,
  link: false,
  underline: false,
});

type ToolbarButtonProps = Readonly<{
  label: string;
  icon: LucideIcon;
  active: boolean;
  onPress: () => void;
}>;

function ToolbarButton({
  label,
  icon: Icon,
  active,
  onPress,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      // preventDefault on mousedown keeps the editor selection alive through
      // the press. The action stays on onClick: Enter/Space on a focused button
      // dispatches click and never mousedown, so driving it from mousedown
      // would leave every control tabbable and inert.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPress}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground"
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function EditorToolbar({ editor }: Readonly<{ editor: Editor }>) {
  const chain = () => editor.chain().focus();
  return (
    <div className="flex items-center gap-0.5 border-b border-input px-1.5 py-1">
      <ToolbarButton
        label="Bold"
        icon={Bold}
        active={editor.isActive("bold")}
        onPress={() => chain().toggleBold().run()}
      />
      <ToolbarButton
        label="Italic"
        icon={Italic}
        active={editor.isActive("italic")}
        onPress={() => chain().toggleItalic().run()}
      />
      <ToolbarButton
        label="Bullet list"
        icon={List}
        active={editor.isActive("bulletList")}
        onPress={() => chain().toggleBulletList().run()}
      />
      <ToolbarButton
        label="Numbered list"
        icon={ListOrdered}
        active={editor.isActive("orderedList")}
        onPress={() => chain().toggleOrderedList().run()}
      />
    </div>
  );
}

type RichTextEditorProps = Readonly<{
  id: string;
  ariaLabel: string;
  value: string;
  onChange: (html: string) => void;
}>;

export function RichTextEditor({
  id,
  ariaLabel,
  value,
  onChange,
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [EMAIL_STARTER_KIT],
    content: value,
    // Next.js renders on the server first; TipTap must wait for the client.
    immediatelyRender: false,
    // The toolbar's active states read the selection, so the component must
    // re-render per transaction (v3 default is not to).
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        id,
        // A contenteditable div is not a labelable element, so <Label htmlFor>
        // cannot bind to it. The role and name have to live here instead.
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel,
        class:
          "min-h-[72px] px-3 py-2 text-sm focus:outline-none [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5",
      },
    },
    onUpdate: ({ editor: current }) =>
      onChange(toStoredValue(current.getHTML())),
  });

  // External value changes (the async settings load, Restore Defaults) must
  // reach the editor; its own keystrokes already arrived via onUpdate.
  //
  // emitUpdate must be explicit: @tiptap/core 3.30.1 defaults setContent to
  // emitUpdate: true, where v2 was silent. On the default this effect echoes
  // into the parent's state, so the settings GET alone dirties the form and
  // ProseMirror's normalisation of the stored HTML is saved unasked.
  useEffect(() => {
    if (editor && toStoredValue(editor.getHTML()) !== value) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [editor, value]);

  return (
    <div className="rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
      {editor ? <EditorToolbar editor={editor} /> : null}
      <EditorContent editor={editor} />
    </div>
  );
}
