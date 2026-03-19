import type {
  AcbDocument,
  ReviewStateDocument,
  GroupVerdictValue,
  OverallVerdictValue,
} from "./types.js";
import { computeAcbHash } from "./hash.js";

function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Create a blank review for an ACB document.
 * All intent groups start with verdict "pending".
 */
export function createBlankReview(
  acb: AcbDocument,
  reviewer: string,
  rawAcbContent?: string,
): ReviewStateDocument {
  const acbContent = rawAcbContent ?? JSON.stringify(acb);
  return {
    acb_version: acb.acb_version,
    acb_hash: computeAcbHash(acbContent),
    acb_id: acb.id,
    reviewer,
    group_verdicts: acb.intent_groups.map((g) => ({
      group_id: g.id,
      verdict: "pending" as const,
    })),
    overall_verdict: "pending",
    updated_at: nowISO(),
  };
}

/**
 * Reconcile an existing review against a (possibly updated) ACB.
 * - Preserves verdicts for groups that still exist in the ACB
 * - Adds new groups as "pending"
 * - Removes verdicts for groups no longer in the ACB
 * - Updates acb_hash and acb_id to match the current ACB
 */
export function reconcileReview(
  review: ReviewStateDocument,
  acb: AcbDocument,
  rawAcbContent?: string,
): ReviewStateDocument {
  const acbContent = rawAcbContent ?? JSON.stringify(acb);
  const acbHash = computeAcbHash(acbContent);

  if (review.acb_hash === acbHash) {
    return review;
  }

  const existingByGroupId = new Map(
    review.group_verdicts.map((g) => [g.group_id, g]),
  );

  return {
    ...review,
    acb_version: acb.acb_version,
    acb_hash: acbHash,
    acb_id: acb.id,
    group_verdicts: acb.intent_groups.map((g) => {
      const existing = existingByGroupId.get(g.id);
      return existing ? { ...existing } : { group_id: g.id, verdict: "pending" as const };
    }),
    updated_at: nowISO(),
  };
}

/**
 * Set the verdict for a specific intent group.
 * Returns a new ReviewStateDocument (immutable update).
 * Throws if groupId is not found.
 */
export function setGroupVerdict(
  review: ReviewStateDocument,
  groupId: string,
  verdict: GroupVerdictValue,
  comment?: string,
): ReviewStateDocument {
  const idx = review.group_verdicts.findIndex((g) => g.group_id === groupId);
  if (idx === -1) {
    throw new Error(`Group verdict not found for groupId: ${groupId}`);
  }

  const updatedVerdicts = review.group_verdicts.map((g, i) => {
    if (i !== idx) return { ...g };
    return { ...g, verdict, ...(comment !== undefined ? { comment } : {}) };
  });

  return {
    ...review,
    group_verdicts: updatedVerdicts,
    updated_at: nowISO(),
  };
}

/**
 * Add or update an annotation response within a group verdict.
 * Returns a new ReviewStateDocument (immutable update).
 */
export function setAnnotationResponse(
  review: ReviewStateDocument,
  groupId: string,
  annotationId: string,
  response: string,
): ReviewStateDocument {
  const idx = review.group_verdicts.findIndex((g) => g.group_id === groupId);
  if (idx === -1) {
    throw new Error(`Group verdict not found for groupId: ${groupId}`);
  }

  const updatedVerdicts = review.group_verdicts.map((g, i) => {
    if (i !== idx) return { ...g };

    const existing = g.annotation_responses ?? [];
    const arIdx = existing.findIndex((ar) => ar.annotation_id === annotationId);

    let updatedResponses;
    if (arIdx === -1) {
      updatedResponses = [...existing, { annotation_id: annotationId, response }];
    } else {
      updatedResponses = existing.map((ar, j) =>
        j === arIdx ? { ...ar, response } : { ...ar },
      );
    }

    return { ...g, annotation_responses: updatedResponses };
  });

  return {
    ...review,
    group_verdicts: updatedVerdicts,
    updated_at: nowISO(),
  };
}

/**
 * Add or update a question answer.
 * Returns a new ReviewStateDocument (immutable update).
 */
export function answerQuestion(
  review: ReviewStateDocument,
  questionId: string,
  answer: string,
): ReviewStateDocument {
  const existing = review.question_answers ?? [];
  const idx = existing.findIndex((qa) => qa.question_id === questionId);

  let updatedAnswers;
  if (idx === -1) {
    updatedAnswers = [...existing, { question_id: questionId, answer }];
  } else {
    updatedAnswers = existing.map((qa, i) =>
      i === idx ? { ...qa, answer } : { ...qa },
    );
  }

  return {
    ...review,
    question_answers: updatedAnswers,
    updated_at: nowISO(),
  };
}

/**
 * Set the overall verdict for the review.
 * Returns a new ReviewStateDocument (immutable update).
 */
export function setOverallVerdict(
  review: ReviewStateDocument,
  verdict: OverallVerdictValue,
  comment?: string,
): ReviewStateDocument {
  return {
    ...review,
    overall_verdict: verdict,
    ...(comment !== undefined ? { overall_comment: comment } : {}),
    updated_at: nowISO(),
  };
}

/**
 * Serialize a ReviewStateDocument to a formatted JSON string (2-space indent).
 */
export function serializeReview(review: ReviewStateDocument): string {
  return JSON.stringify(review, null, 2);
}
