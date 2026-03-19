import React, { useState } from "react";
import type { OverallVerdictValue } from "@acb/core";
import { useAcb } from "./hooks/useAcb";
import { useReview } from "./hooks/useReview";
import { ProgressBar } from "./components/ProgressBar";
import { IntentGroupCard } from "./components/IntentGroupCard";
import { OpenQuestionSection } from "./components/OpenQuestionSection";
import { NegativeSpaceSection } from "./components/NegativeSpaceSection";
import "./styles/acb-review.css";

const OVERALL_BUTTONS: { value: OverallVerdictValue; label: string }[] = [
  { value: "approved", label: "Approve" },
  { value: "changes_requested", label: "Request Changes" },
];

export function App(): React.ReactElement {
  const { acb, review, error } = useAcb();
  const actions = useReview();
  const [overallComment, setOverallComment] = useState("");

  if (error) {
    return <div className="acb-error">Error: {error}</div>;
  }

  if (!acb) {
    return <div className="acb-loading">ACB Review Loading...</div>;
  }

  const groupTitles = new Map(acb.intent_groups.map((g) => [g.id, g.title]));
  const verdicts = review?.group_verdicts ?? [];
  const verdictMap = new Map(verdicts.map((v) => [v.group_id, v]));
  const questionAnswers = review?.question_answers ?? [];
  const currentOverall = review?.overall_verdict ?? "pending";

  return (
    <div className="acb-review">
      {/* Header */}
      <div className="acb-header">
        <h1>ACB Review</h1>
        <div className="acb-header-meta">
          <span>Version: {acb.acb_version}</span>
          <span>Generated: {acb.generated_at}</span>
          {acb.agent_id && <span>Agent: {acb.agent_id}</span>}
        </div>
      </div>

      {/* Progress */}
      <ProgressBar groups={acb.intent_groups} verdicts={verdicts} />

      {/* Intent Groups */}
      {acb.intent_groups.map((group) => (
        <IntentGroupCard
          key={group.id}
          group={group}
          verdict={verdictMap.get(group.id)}
          groupTitles={groupTitles}
          onSetVerdict={actions.setVerdict}
          onRespondToAnnotation={actions.respondToAnnotation}
          onNavigateFile={actions.navigateToFile}
          onShowDiff={actions.showGroupDiff}
        />
      ))}

      {/* Open Questions */}
      {acb.open_questions && (
        <OpenQuestionSection
          questions={acb.open_questions}
          answers={questionAnswers}
          onAnswer={actions.answerQuestion}
        />
      )}

      {/* Negative Space */}
      {acb.negative_space && <NegativeSpaceSection entries={acb.negative_space} />}

      {/* Overall Verdict */}
      <div className="overall-section">
        <h2>Overall Verdict</h2>
        <div className="verdict-buttons">
          {OVERALL_BUTTONS.map((btn) => (
            <button
              key={btn.value}
              className={`verdict-btn verdict-btn--${btn.value === "approved" ? "accepted" : "rejected"} ${currentOverall === btn.value ? "verdict-btn--active" : ""}`}
              onClick={() => actions.setOverall(btn.value, overallComment || undefined)}
            >
              {btn.label}
            </button>
          ))}
        </div>
        <textarea
          className="acb-textarea"
          placeholder="Overall comment (optional)..."
          value={overallComment}
          onChange={(e) => setOverallComment(e.target.value)}
          onBlur={() => {
            if (overallComment.trim() && currentOverall !== "pending") {
              actions.setOverall(currentOverall as OverallVerdictValue, overallComment);
            }
          }}
        />
        {review && (
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>
            Last updated: {review.updated_at}
          </div>
        )}
      </div>
    </div>
  );
}
