import React, { useState } from "react";
import type { IntentGroup, GroupVerdict, GroupVerdictValue } from "@acb/core";
import { ClassificationBadge } from "./ClassificationBadge";
import { AmbiguityTag } from "./AmbiguityTag";
import { FileRefLink } from "./FileRefLink";
import { AnnotationBlock } from "./AnnotationBlock";

interface Props {
  group: IntentGroup;
  verdict: GroupVerdict | undefined;
  /** Map from group ID to group title, for resolving causal link references */
  groupTitles: Map<string, string>;
  onSetVerdict: (groupId: string, verdict: GroupVerdictValue, comment?: string) => void;
  onRespondToAnnotation: (groupId: string, annotationId: string, response: string) => void;
  onNavigateFile: (path: string, ranges: string[]) => void;
  onShowDiff: (groupId: string) => void;
}

const VERDICT_BUTTONS: { value: GroupVerdictValue; label: string }[] = [
  { value: "accepted", label: "Accept" },
  { value: "rejected", label: "Reject" },
  { value: "needs_discussion", label: "Needs Discussion" },
];

export function IntentGroupCard({
  group,
  verdict,
  groupTitles,
  onSetVerdict,
  onRespondToAnnotation,
  onNavigateFile,
  onShowDiff,
}: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [groundingVisible, setGroundingVisible] = useState(false);
  const [comment, setComment] = useState(verdict?.comment ?? "");
  const currentVerdict = verdict?.verdict ?? "pending";

  const responseMap = new Map(
    (verdict?.annotation_responses ?? []).map((r) => [r.annotation_id, r.response]),
  );

  return (
    <div className={`intent-card intent-card--${currentVerdict}`}>
      <div className="intent-card-header" onClick={() => setExpanded(!expanded)}>
        <span className={`intent-card-chevron ${expanded ? "intent-card-chevron--open" : ""}`}>&#9654;</span>
        <span className="intent-card-title">{group.title}</span>
        <ClassificationBadge classification={group.classification} />
        <button
          className="show-diff-btn"
          title="Show Changes"
          onClick={(e) => {
            e.stopPropagation();
            onShowDiff(group.id);
          }}
        >
          Show Changes
        </button>
      </div>

      {expanded && (
        <div className="intent-card-body">
          {/* Ambiguity tags */}
          {group.ambiguity_tags.length > 0 && (
            <div className="tags-row">
              {group.ambiguity_tags.map((tag) => (
                <AmbiguityTag key={tag} tag={tag} />
              ))}
            </div>
          )}

          {/* Task grounding */}
          <div style={{ marginTop: 8 }}>
            <span
              className="section-label"
              style={{ cursor: "pointer" }}
              onClick={() => setGroundingVisible(!groundingVisible)}
            >
              Task Grounding {groundingVisible ? "[-]" : "[+]"}
            </span>
            {groundingVisible && <div className="task-grounding">{group.task_grounding}</div>}
          </div>

          {/* File refs */}
          {group.file_refs.length > 0 && (
            <>
              <div className="section-label">Files</div>
              <div className="file-refs-list">
                {group.file_refs.map((ref, i) => (
                  <FileRefLink key={i} fileRef={ref} onClick={onNavigateFile} />
                ))}
              </div>
            </>
          )}

          {/* Annotations */}
          {group.annotations && group.annotations.length > 0 && (
            <>
              <div className="section-label">Annotations</div>
              {group.annotations.map((ann) => (
                <AnnotationBlock
                  key={ann.id}
                  annotation={ann}
                  groupId={group.id}
                  existingResponse={responseMap.get(ann.id)}
                  onRespond={onRespondToAnnotation}
                />
              ))}
            </>
          )}

          {/* Causal links */}
          {group.causal_links && group.causal_links.length > 0 && (
            <>
              <div className="section-label">Causal Links</div>
              {group.causal_links.map((link, i) => (
                <div key={i} className="causal-link">
                  Caused by:{" "}
                  <span className="causal-link-target">
                    {groupTitles.get(link.target_group_id) ?? link.target_group_id}
                  </span>
                  {link.rationale && <> &mdash; {link.rationale}</>}
                </div>
              ))}
            </>
          )}

          {/* Verdict buttons */}
          <div className="verdict-buttons">
            {VERDICT_BUTTONS.map((btn) => (
              <button
                key={btn.value}
                className={`verdict-btn verdict-btn--${btn.value} ${currentVerdict === btn.value ? "verdict-btn--active" : ""}`}
                onClick={() => onSetVerdict(group.id, btn.value, comment || undefined)}
              >
                {btn.label}
              </button>
            ))}
          </div>

          {/* Comment */}
          <textarea
            className="acb-textarea"
            placeholder="Comment (optional)..."
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onBlur={() => {
              if (comment !== (verdict?.comment ?? "")) {
                onSetVerdict(group.id, currentVerdict, comment || undefined);
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
