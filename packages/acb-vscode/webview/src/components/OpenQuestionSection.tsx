import React, { useState } from "react";
import type { OpenQuestion, QuestionAnswer } from "@acb/core";

interface Props {
  questions: OpenQuestion[];
  answers: QuestionAnswer[];
  onAnswer: (questionId: string, answer: string) => void;
}

export function OpenQuestionSection({ questions, answers, onAnswer }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);

  if (questions.length === 0) return <></>;

  const answerMap = new Map(answers.map((a) => [a.question_id, a.answer]));

  return (
    <div className="collapsible-section">
      <div className="collapsible-header" onClick={() => setOpen(!open)}>
        <span className={`intent-card-chevron ${open ? "intent-card-chevron--open" : ""}`}>&#9654;</span>
        Open Questions ({questions.length})
      </div>
      {open && (
        <div className="collapsible-body">
          {questions.map((q) => (
            <QuestionItem
              key={q.id}
              question={q}
              existingAnswer={answerMap.get(q.id)}
              onAnswer={onAnswer}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QuestionItem({
  question,
  existingAnswer,
  onAnswer,
}: {
  question: OpenQuestion;
  existingAnswer?: string;
  onAnswer: (id: string, answer: string) => void;
}): React.ReactElement {
  const [answer, setAnswer] = useState(existingAnswer ?? "");

  return (
    <div className="open-question-item">
      <div className="open-question-text">{question.question}</div>
      <div className="open-question-context">{question.context}</div>
      <div className="open-question-default">Default: {question.default_behavior}</div>
      <textarea
        className="acb-textarea"
        placeholder="Your answer..."
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onBlur={() => {
          if (answer.trim()) {
            onAnswer(question.id, answer);
          }
        }}
      />
    </div>
  );
}
