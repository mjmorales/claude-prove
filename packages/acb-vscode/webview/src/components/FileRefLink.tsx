import React from "react";
import type { FileRef } from "@acb/core";

const HINT_LABELS: Record<string, string> = {
  changed_region: "changed",
  full_file: "full",
  context: "ctx",
};

interface Props {
  fileRef: FileRef;
  onClick: (path: string, ranges: string[]) => void;
}

export function FileRefLink({ fileRef, onClick }: Props): React.ReactElement {
  const rangeStr = fileRef.ranges.length > 0 ? `:${fileRef.ranges.join(",")}` : "";
  const label = `${fileRef.path}${rangeStr}`;

  return (
    <span
      className="file-ref-link"
      role="link"
      tabIndex={0}
      onClick={() => onClick(fileRef.path, fileRef.ranges)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onClick(fileRef.path, fileRef.ranges);
      }}
    >
      {label}
      {fileRef.view_hint && (
        <span className="file-ref-hint">[{HINT_LABELS[fileRef.view_hint] ?? fileRef.view_hint}]</span>
      )}
    </span>
  );
}
