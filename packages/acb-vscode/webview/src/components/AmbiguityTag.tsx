import React from "react";
import type { AmbiguityTag as AmbiguityTagType } from "@acb/core";

function formatTag(tag: AmbiguityTagType): string {
  return tag
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface Props {
  tag: AmbiguityTagType;
}

export function AmbiguityTag({ tag }: Props): React.ReactElement {
  return <span className="ambiguity-tag">{formatTag(tag)}</span>;
}
