import React, { useState } from "react";
import type { NegativeSpaceEntry, NegativeSpaceReason } from "@acb/core";

const REASON_LABELS: Record<NegativeSpaceReason, string> = {
  out_of_scope: "Out of Scope",
  possible_other_callers: "Possible Other Callers",
  intentionally_preserved: "Intentionally Preserved",
  would_require_escalation: "Would Require Escalation",
};

interface Props {
  entries: NegativeSpaceEntry[];
}

export function NegativeSpaceSection({ entries }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);

  if (entries.length === 0) return <></>;

  return (
    <div className="collapsible-section">
      <div className="collapsible-header" onClick={() => setOpen(!open)}>
        <span className={`intent-card-chevron ${open ? "intent-card-chevron--open" : ""}`}>&#9654;</span>
        Negative Space ({entries.length})
      </div>
      {open && (
        <div className="collapsible-body">
          {entries.map((entry, i) => (
            <div key={i} className="negative-space-item">
              <div className="negative-space-path">
                {entry.path}
                {entry.ranges && entry.ranges.length > 0 ? `:${entry.ranges.join(",")}` : ""}
              </div>
              <div className="negative-space-reason">{REASON_LABELS[entry.reason]}</div>
              <div className="negative-space-explanation">{entry.explanation}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
