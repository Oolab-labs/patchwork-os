"use client";

import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from "@codemirror/view";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldKeymap } from "@codemirror/language";
import { yaml } from "@codemirror/lang-yaml";
import { linter, type Diagnostic } from "@codemirror/lint";

/**
 * Lint issue shape mirrored from `src/recipes/validation.ts`. Kept
 * local so the editor component has no cross-package import; the
 * dashboard route fetches `LintIssue[]` from `/api/bridge/recipes/lint`
 * and forwards via the `lintIssues` prop.
 */
export interface YamlLintIssue {
  level: "error" | "warning";
  message: string;
  /** 1-indexed line; when present, drives the gutter marker position. */
  line?: number;
  /** 1-indexed column; optional — when absent, the marker spans the line. */
  column?: number;
  code?: string;
  path?: string;
}

/**
 * State effect + field used to push lint diagnostics into the editor
 * imperatively. CodeMirror's `linter()` is normally for async
 * source-based lint passes; since our diagnostics come from a
 * debounced server-side `/recipes/lint` fetch upstream, we shove them
 * in via a StateField + effect instead.
 */
const setLintDiagnostics = StateEffect.define<readonly Diagnostic[]>();
const lintDiagnosticsField = StateField.define<readonly Diagnostic[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLintDiagnostics)) return effect.value;
    }
    return value;
  },
});

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
    // Phase 1B: lint extension reads diagnostics from a StateField
    // populated imperatively by the parent component when `/recipes/lint`
    // returns structured `LintIssue[]`. The linter() call provides the
    // gutter markers, hover messages, and inline squiggles for free.
    lintDiagnosticsField,
    linter((view) => Array.from(view.state.field(lintDiagnosticsField))),
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
  highlightLine,
  lintIssues,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  minHeight?: number;
  /**
   * 1-based line number to scroll into view + briefly highlight.
   * Used by the failed-run → YAML deep-link to land the user on the
   * exact step that broke.
   */
  highlightLine?: number;
  /**
   * Phase 1B: structured lint issues to render as inline gutter
   * diagnostics + squiggles. The route page fetches `/recipes/lint` and
   * forwards the response; issues without a `line` field are dropped
   * here (no gutter marker possible without a position — the lint
   * banner still shows them as text).
   */
  lintIssues?: YamlLintIssue[];
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

  // Phase 1B: sync lint issues → CodeMirror diagnostics. Re-fires when
  // the parent fetches a new lint result. Issues without a `line` field
  // are dropped (no source position → can't render a gutter marker —
  // the route-level banner still shows them as text). One line per
  // issue: span the whole line so the gutter marker + hover are
  // unambiguous, even when `column` is set.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const issues = lintIssues ?? [];
    const doc = view.state.doc;
    const diagnostics: Diagnostic[] = [];
    for (const issue of issues) {
      if (typeof issue.line !== "number") continue;
      const lineNum = Math.max(1, Math.min(issue.line, doc.lines));
      const line = doc.line(lineNum);
      diagnostics.push({
        from: line.from,
        to: line.to,
        severity: issue.level === "error" ? "error" : "warning",
        message: issue.message,
        source: issue.code,
      });
    }
    view.dispatch({ effects: setLintDiagnostics.of(diagnostics) });
  }, [lintIssues]);

  // Scroll-to-line for the failed-run → YAML deep-link. Re-fires whenever
  // `highlightLine` or `value` changes — covers both the "land here on
  // initial load" and "user clicked a different step's deep link" cases.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !highlightLine) return;
    const doc = view.state.doc;
    if (highlightLine < 1 || highlightLine > doc.lines) return;
    const line = doc.line(highlightLine);
    view.dispatch({
      selection: { anchor: line.from, head: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.focus();
  }, [highlightLine, value]);

  return (
    <div
      ref={containerRef}
      className="pw-cm-editor"
      style={{ minHeight, borderRadius: "var(--r-2)" }}
    />
  );
}
