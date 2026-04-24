import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

marked.setOptions({ gfm: true, breaks: false });

// Sanitize marked.parse() output before injection. Any Markdown source
// reaching this component may be user-influenced via run artifacts, so we
// strip script/style/event-handler vectors even when the source looks trusted.
export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source) as string),
    [source],
  );
  return (
    <div
      className={`prose-md ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
