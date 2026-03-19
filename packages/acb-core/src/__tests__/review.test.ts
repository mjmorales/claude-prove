import { describe, it, expect } from "vitest";
import {
  createBlankReview,
  setGroupVerdict,
  setAnnotationResponse,
  answerQuestion,
  setOverallVerdict,
  serializeReview,
} from "../review.js";
import type { AcbDocument } from "../types.js";

const TEST_ACB: AcbDocument = {
  acb_version: "0.1",
  id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  change_set_ref: { base_ref: "abc1234", head_ref: "def5678" },
  task_statement: {
    turns: [
      {
        turn_id: "turn-1",
        role: "user",
        content:
          "Add input validation to the login endpoint. Reject empty usernames.",
      },
    ],
  },
  intent_groups: [
    {
      id: "group-1",
      title: "Add username validation to login handler",
      classification: "explicit",
      ambiguity_tags: [],
      task_grounding: "Turn turn-1 directly requests it.",
      file_refs: [{ path: "src/auth/login.go", ranges: ["15-28"] }],
    },
    {
      id: "group-2",
      title: "Add test for empty username rejection",
      classification: "inferred",
      ambiguity_tags: [],
      task_grounding: "Test coverage needed.",
      file_refs: [{ path: "src/auth/login_test.go", ranges: ["45-62"] }],
    },
  ],
  generated_at: "2026-03-19T14:30:00Z",
  agent_id: "claude-opus-4.6",
};

describe("createBlankReview", () => {
  it("creates group verdicts for each intent group", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    expect(review.group_verdicts).toHaveLength(2);
  });

  it("sets all group verdicts to pending", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    for (const gv of review.group_verdicts) {
      expect(gv.verdict).toBe("pending");
    }
  });

  it("sets the correct acb_id", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    expect(review.acb_id).toBe(TEST_ACB.id);
  });

  it("sets overall_verdict to pending", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    expect(review.overall_verdict).toBe("pending");
  });

  it("sets the reviewer", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    expect(review.reviewer).toBe("reviewer-1");
  });

  it("computes a valid acb_hash", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    expect(review.acb_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("setGroupVerdict", () => {
  it("updates the correct group verdict", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    const updated = setGroupVerdict(review, "group-1", "accepted", "Looks good");
    const gv = updated.group_verdicts.find((g) => g.group_id === "group-1");
    expect(gv?.verdict).toBe("accepted");
    expect(gv?.comment).toBe("Looks good");
  });

  it("returns a new object (does not mutate the original)", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    const updated = setGroupVerdict(review, "group-1", "accepted");
    expect(updated).not.toBe(review);
    expect(review.group_verdicts[0].verdict).toBe("pending");
  });

  it("throws if groupId is not found", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    expect(() => setGroupVerdict(review, "nonexistent", "accepted")).toThrow(
      /not found/,
    );
  });
});

describe("setAnnotationResponse", () => {
  it("adds a new annotation response", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    const updated = setAnnotationResponse(
      review,
      "group-1",
      "ann-1",
      "Acknowledged",
    );
    const gv = updated.group_verdicts.find((g) => g.group_id === "group-1");
    expect(gv?.annotation_responses).toHaveLength(1);
    expect(gv?.annotation_responses?.[0]).toEqual({
      annotation_id: "ann-1",
      response: "Acknowledged",
    });
  });

  it("updates an existing annotation response", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    const step1 = setAnnotationResponse(review, "group-1", "ann-1", "First");
    const step2 = setAnnotationResponse(step1, "group-1", "ann-1", "Updated");
    const gv = step2.group_verdicts.find((g) => g.group_id === "group-1");
    expect(gv?.annotation_responses).toHaveLength(1);
    expect(gv?.annotation_responses?.[0].response).toBe("Updated");
  });
});

describe("answerQuestion", () => {
  it("adds a new question answer", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    const updated = answerQuestion(review, "q-1", "Yes, go ahead");
    expect(updated.question_answers).toHaveLength(1);
    expect(updated.question_answers?.[0]).toEqual({
      question_id: "q-1",
      answer: "Yes, go ahead",
    });
  });

  it("updates an existing question answer", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    const step1 = answerQuestion(review, "q-1", "First answer");
    const step2 = answerQuestion(step1, "q-1", "Revised answer");
    expect(step2.question_answers).toHaveLength(1);
    expect(step2.question_answers?.[0].answer).toBe("Revised answer");
  });
});

describe("setOverallVerdict", () => {
  it("updates the overall verdict", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    const updated = setOverallVerdict(review, "approved");
    expect(updated.overall_verdict).toBe("approved");
  });

  it("sets the overall comment", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    const updated = setOverallVerdict(review, "changes_requested", "Fix tests");
    expect(updated.overall_verdict).toBe("changes_requested");
    expect(updated.overall_comment).toBe("Fix tests");
  });
});

describe("serializeReview", () => {
  it("produces valid JSON", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    const json = serializeReview(review);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("uses 2-space indentation", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    const json = serializeReview(review);
    // 2-space indent means lines should start with "  " not "    " at first level
    expect(json).toContain('\n  "acb_version"');
  });
});
