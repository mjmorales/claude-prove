import React from "react";
import type { Classification } from "@acb/core";

const LABELS: Record<Classification, string> = {
  explicit: "Explicit",
  inferred: "Inferred",
  speculative: "Speculative",
};

interface Props {
  classification: Classification;
}

export function ClassificationBadge({ classification }: Props): React.ReactElement {
  return (
    <span className={`classification-badge classification-badge--${classification}`}>
      {LABELS[classification]}
    </span>
  );
}
