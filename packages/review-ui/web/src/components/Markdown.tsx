import { useMemo } from "react";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => marked.parse(source) as string, [source]);
  return (
    <div
      className={`prose-md ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
