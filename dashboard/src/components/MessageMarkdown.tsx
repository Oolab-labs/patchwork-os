"use client";

// Wrapper that bundles react-markdown + its plugins. Imported via
// next/dynamic from the inbox page so the ~80KB markdown chunk doesn't
// ship in the inbox initial bundle — only loaded once the user opens a
// message detail.
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

export default function MessageMarkdown({
  content,
  components,
}: {
  content: string;
  components: Components;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}
