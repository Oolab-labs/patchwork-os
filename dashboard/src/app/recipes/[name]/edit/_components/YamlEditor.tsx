"use client";

import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldKeymap } from "@codemirror/language";
import { yaml } from "@codemirror/lang-yaml";

// Minimal theme matching patchwork design tokens (both light/dark via CSS vars).
// CM themes use static strings, so we inject a <style> for var() mappings.
const STYLE_ID = "patchwork-cm-style";

function ensureStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
    .pw-cm-editor .cm-editor {
      border: 1px solid var(--line-2);
      border-radius: var(--r-2, 8px);
      min-height: inherit;
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 13px;
      line-height: 1.6;
      outline: none;
    }
    .pw-cm-editor .cm-editor.cm-focused {
      border-color: var(--accent);
    }
    .pw-cm-editor .cm-scroller {
      min-height: inherit;
    }
    .pw-cm-editor .cm-content {
      padding: 12px 4px;
      caret-color: var(--ink-0);
    }
    .pw-cm-editor .cm-line { color: var(--ink-0); }
    .pw-cm-editor .cm-gutters {
      background: var(--recess);
      border-right: 1px solid var(--line-1);
      color: var(--ink-3);
    }
    .pw-cm-editor .cm-activeLineGutter { background: var(--line-1); }
    .pw-cm-editor .cm-activeLine { background: var(--line-1); }
    .pw-cm-editor .cm-cursor { border-left-color: var(--ink-0); }
    .pw-cm-editor .cm-selectionBackground, .pw-cm-editor .cm-focused .cm-selectionBackground {
      background: rgba(var(--accent-rgb, 197,83,42), 0.2) !important;
    }
    /* YAML token colours — orange for keys, blue-ish for strings */
    .pw-cm-editor .ͼo { color: var(--orange); }          /* keyword */
    .pw-cm-editor .ͼm { color: var(--green); }           /* string */
    .pw-cm-editor .ͼl { color: var(--blue, #5080c0); }   /* number */
    .pw-cm-editor .ͼc { color: var(--ink-3); font-style: italic; }  /* comment */
    .pw-cm-editor .ͼd { color: var(--accent); }          /* definition */
    .pw-cm-editor .ͼi { color: var(--blue, #5080c0); }   /* bool */
  `;
  document.head.appendChild(el);
}

function makeExtensions(onSave: () => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    yaml(),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
      { key: "Mod-s", run: () => { onSave(); return true; } },
    ]),
    EditorView.lineWrapping,
  ];
}

export default function YamlEditor({
  value,
  onChange,
  onSave,
  minHeight = 400,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  minHeight?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // Mount editor once
  useEffect(() => {
    ensureStyle();
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        ...makeExtensions(() => onSaveRef.current?.()),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // mount once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes (e.g. initial load from API) without
  // clobbering cursor position if the change came from within the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      ref={containerRef}
      className="pw-cm-editor"
      style={{ minHeight, borderRadius: "var(--r-2)" }}
    />
  );
}
