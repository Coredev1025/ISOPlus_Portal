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
      // Preventing mousedown's default is what keeps the editor selection
      // alive through the press; it does not cancel the click that follows.
      // The action hangs off onClick because a focused button activated by
      // Enter or Space dispatches click and never mousedown — wiring the
      // action to mousedown alone leaves every control tabbable and inert.
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
    extensions: [StarterKit],
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
  // emitUpdate is explicit because @tiptap/core 3.30.1 defaults setContent to
  // emitUpdate: true — it was silent in v2. Left to the default, this effect
  // echoes straight back into the parent's state: the settings GET resolving
  // would dirty the form before the user touched anything, and any stored
  // value that does not round-trip through the ProseMirror schema (a legacy
  // plain-text emailMessage, HTML with tags StarterKit drops) would be
  // rewritten to its normalised form and persisted by the next Save with
  // nothing shown to the user. Rewriting is what an edit is for, so the
  // conversion happens when the user actually types, not on opening the tab.
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
