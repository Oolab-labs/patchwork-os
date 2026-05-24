import type { CSSProperties, ReactNode } from "react";

export function CodeBlock({
  children,
  style,
  className,
}: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <pre className={`code-block${className ? ` ${className}` : ""}`} style={{ margin: 0, ...style }}>
      {children}
    </pre>
  );
}

/** Lightweight YAML coloriser — keys, values, comments. */
export function highlightYaml(yaml: string): ReactNode {
  const lines = yaml.split("\n");
  return lines.map((line, i) => {
    const commentIdx = line.indexOf("#");
    let codePart = line;
    let comment = "";
    if (commentIdx >= 0) {
      const before = line.slice(0, commentIdx);
      const quoteOpen = (before.match(/"/g) ?? []).length % 2 === 1;
      if (!quoteOpen) {
        codePart = before;
        comment = line.slice(commentIdx);
      }
    }
    const m = codePart.match(/^(\s*-?\s*)([A-Za-z0-9_./-]+)(\s*:)(\s*)(.*)$/);
    let body: ReactNode = codePart;
    if (m) {
      const [, lead, key, colon, ws, rest] = m;
      body = (
        <>
          <span>{lead}</span>
          <span className="yaml-key" style={{ color: "var(--accent)" }}>{key}</span>
          <span>{colon}</span>
          <span>{ws}</span>
          {rest && (
            <span className="yaml-string" style={{ color: "var(--ok)" }}>{rest}</span>
          )}
        </>
      );
    }
    // biome-ignore lint/suspicious/noArrayIndexKey: rendering raw text lines, no stable id available
    return (
      <div key={i}>
        {body}
        {comment && (
          <span className="yaml-comment" style={{ color: "var(--ink-3)", fontStyle: "italic" }}>
            {comment}
          </span>
        )}
        {!line && " "}
      </div>
    );
  });
}

export function YamlLine({
  k,
  v,
  comment,
  indent = 0,
}: {
  k?: string;
  v?: string;
  comment?: string;
  indent?: number;
}) {
  return (
    <div>
      {indent > 0 && <span>{" ".repeat(indent * 2)}</span>}
      {k && <span className="yaml-key">{k}:</span>}
      {v && <span> <span className="yaml-string">{v}</span></span>}
      {comment && <span className="yaml-comment">{k || v ? "  " : ""}# {comment}</span>}
    </div>
  );
}
