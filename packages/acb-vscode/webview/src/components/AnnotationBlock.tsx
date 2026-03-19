import React, { useState } from "react";
import type { Annotation } from "@acb/core";
import { AmbiguityTag } from "./AmbiguityTag";

const TYPE_LABELS: Record<string, string> = {
  judgment_call: "Judgment Call",
  note: "Note",
  flag: "Flag",
};

interface Props {
  annotation: Annotation;
  groupId: string;
  existingResponse?: string;
  onRespond: (groupId: string, annotationId: string, response: string) => void;
}

export function AnnotationBlock({ annotation, groupId, existingResponse, onRespond }: Props): React.ReactElement {
  const [response, setResponse] = useState(existingResponse ?? "");

  return (
    <div className={`annotation-block annotation-block--${annotation.type}`}>
      <div className="annotation-type-label">{TYPE_LABELS[annotation.type] ?? annotation.type}</div>
      <div className="annotation-body">{annotation.body}</div>

      {annotation.ambiguity_tags && annotation.ambiguity_tags.length > 0 && (
        <div className="tags-row">
          {annotation.ambiguity_tags.map((tag) => (
            <AmbiguityTag key={tag} tag={tag} />
          ))}
        </div>
      )}

      {annotation.type === "judgment_call" && (
        <textarea
          className="acb-textarea"
          placeholder="Your response to this judgment call..."
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          onBlur={() => {
            if (response.trim()) {
              onRespond(groupId, annotation.id, response);
            }
          }}
        />
      )}
    </div>
  );
}
