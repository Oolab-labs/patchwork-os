import type { CSSProperties, ReactNode } from "react";

export function CodeBlock({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <pre className="code-block" style={{ margin: 0, ...style }}>
      {children}
    </pre>
  );
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
