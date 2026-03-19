import { describe, it, expect } from "vitest";
import { computeAcbHash, isReviewStale } from "../hash.js";
import { createBlankReview } from "../review.js";
import type { AcbDocument } from "../types.js";

const TEST_ACB_JSON = `{"acb_version":"0.1","id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","change_set_ref":{"base_ref":"abc1234","head_ref":"def5678"},"task_statement":{"turns":[{"turn_id":"turn-1","role":"user","content":"Add input validation to the login endpoint. Reject empty usernames."}]},"intent_groups":[{"id":"group-1","title":"Add username validation to login handler","classification":"explicit","ambiguity_tags":[],"task_grounding":"Turn turn-1 directly requests it.","file_refs":[{"path":"src/auth/login.go","ranges":["15-28"]}]},{"id":"group-2","title":"Add test for empty username rejection","classification":"inferred","ambiguity_tags":[],"task_grounding":"Test coverage needed.","file_refs":[{"path":"src/auth/login_test.go","ranges":["45-62"]}]}],"generated_at":"2026-03-19T14:30:00Z","agent_id":"claude-opus-4.6"}`;

const TEST_ACB: AcbDocument = JSON.parse(TEST_ACB_JSON);

describe("computeAcbHash", () => {
  it("returns a 64-character lowercase hex string", () => {
    const hash = computeAcbHash(TEST_ACB_JSON);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same hash for the same input", () => {
    const hash1 = computeAcbHash(TEST_ACB_JSON);
    const hash2 = computeAcbHash(TEST_ACB_JSON);
    expect(hash1).toBe(hash2);
  });

  it("produces a different hash for different input", () => {
    const hash1 = computeAcbHash(TEST_ACB_JSON);
    const hash2 = computeAcbHash(TEST_ACB_JSON + " ");
    expect(hash1).not.toBe(hash2);
  });
});

describe("isReviewStale", () => {
  it("returns false when the ACB content matches the review hash", () => {
    const acbContent = JSON.stringify(TEST_ACB);
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    expect(isReviewStale(acbContent, review)).toBe(false);
  });

  it("returns true when the ACB content has changed", () => {
    const review = createBlankReview(TEST_ACB, "reviewer-1");
    const modifiedContent = JSON.stringify({ ...TEST_ACB, agent_id: "different-agent" });
    expect(isReviewStale(modifiedContent, review)).toBe(true);
  });
});
