import React from "react";
import type { GroupVerdictValue, IntentGroup, GroupVerdict } from "@acb/core";

interface Props {
  groups: IntentGroup[];
  verdicts: GroupVerdict[];
}

export function ProgressBar({ groups, verdicts }: Props): React.ReactElement {
  const total = groups.length;
  if (total === 0) return <></>;

  const counts: Record<GroupVerdictValue, number> = {
    accepted: 0,
    rejected: 0,
    needs_discussion: 0,
    pending: 0,
  };

  const verdictMap = new Map(verdicts.map((v) => [v.group_id, v.verdict]));
  for (const group of groups) {
    const v = verdictMap.get(group.id) ?? "pending";
    counts[v]++;
  }

  const reviewed = total - counts.pending;

  const segments: { key: GroupVerdictValue; count: number }[] = [
    { key: "accepted", count: counts.accepted },
    { key: "rejected", count: counts.rejected },
    { key: "needs_discussion", count: counts.needs_discussion },
    { key: "pending", count: counts.pending },
  ];

  return (
    <div className="progress-bar-container">
      <div className="progress-bar-label">
        {reviewed} of {total} group{total !== 1 ? "s" : ""} reviewed
      </div>
      <div className="progress-bar-track">
        {segments.map(
          (seg) =>
            seg.count > 0 && (
              <div
                key={seg.key}
                className={`progress-bar-segment progress-bar-segment--${seg.key}`}
                style={{ width: `${(seg.count / total) * 100}%` }}
              />
            ),
        )}
      </div>
    </div>
  );
}
