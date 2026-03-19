import { describe, it, expect } from "vitest";
import { parseAcbDocument, parseReviewState } from "../parser.js";

// ---------------------------------------------------------------------------
// Appendix A: Valid ACB Document
// ---------------------------------------------------------------------------

const VALID_ACB = {
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
      task_grounding:
        "Turn turn-1 directly requests: 'Add input validation to the login endpoint. Reject empty usernames.'",
      file_refs: [
        {
          path: "src/auth/login.go",
          ranges: ["15-28"],
          view_hint: "changed_region",
        },
      ],
      annotations: [
        {
          id: "ann-1",
          type: "note",
          body: "Validation uses the existing ValidationError type already defined in src/errors/errors.go.",
        },
      ],
    },
    {
      id: "group-2",
      title: "Add test for empty username rejection",
      classification: "inferred",
      ambiguity_tags: [],
      task_grounding: "Validation logic requires test coverage.",
      file_refs: [
        {
          path: "src/auth/login_test.go",
          ranges: ["45-62"],
          view_hint: "changed_region",
        },
      ],
    },
  ],
  negative_space: [
    {
      path: "src/auth/signup.go",
      reason: "out_of_scope",
      explanation:
        "Signup endpoint has similar validation gaps but the task specifically targets login.",
    },
  ],
  generated_at: "2026-03-19T14:30:00Z",
  agent_id: "claude-opus-4.6",
};

// ---------------------------------------------------------------------------
// Appendix B: Valid Review State Document
// ---------------------------------------------------------------------------

const VALID_REVIEW = {
  acb_version: "0.1",
  acb_hash: "sha256:abc123def456",
  acb_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  reviewer: "alice",
  group_verdicts: [
    { group_id: "group-1", verdict: "accepted" },
    {
      group_id: "group-2",
      verdict: "needs_discussion",
      comment: "Should we also test with whitespace-only usernames?",
    },
  ],
  question_answers: [],
  overall_verdict: "changes_requested",
  overall_comment: "Group 2 needs discussion before merging.",
  updated_at: "2026-03-19T15:00:00Z",
};

// ---------------------------------------------------------------------------
// Tests: parseAcbDocument
// ---------------------------------------------------------------------------

describe("parseAcbDocument", () => {
  it("parses a valid ACB document (Appendix A)", () => {
    const result = parseAcbDocument(JSON.stringify(VALID_ACB));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.acb_version).toBe("0.1");
      expect(result.data.intent_groups).toHaveLength(2);
      expect(result.data.intent_groups[0].classification).toBe("explicit");
      expect(result.data.negative_space).toHaveLength(1);
    }
  });

  it("returns error for invalid JSON", () => {
    const result = parseAcbDocument("{bad json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toBe("$");
      expect(result.errors[0].message).toMatch(/Invalid JSON/);
    }
  });

  it("returns errors for missing required fields", () => {
    const result = parseAcbDocument(JSON.stringify({}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);
      expect(paths).toContain("$.acb_version");
      expect(paths).toContain("$.id");
      expect(paths).toContain("$.change_set_ref");
      expect(paths).toContain("$.task_statement");
      expect(paths).toContain("$.intent_groups");
      expect(paths).toContain("$.generated_at");
    }
  });

  it("returns error for invalid classification enum", () => {
    const doc = structuredClone(VALID_ACB);
    doc.intent_groups[0].classification = "wrong" as any;
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const enumErr = result.errors.find((e) =>
        e.path.includes("classification"),
      );
      expect(enumErr).toBeDefined();
      expect(enumErr!.message).toMatch(/Invalid value "wrong"/);
    }
  });

  it("returns error for invalid ambiguity_tags enum", () => {
    const doc = structuredClone(VALID_ACB);
    doc.intent_groups[0].ambiguity_tags = ["bad_tag" as any];
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path.includes("ambiguity_tags"));
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/Invalid value "bad_tag"/);
    }
  });

  it("returns error for invalid annotation type enum", () => {
    const doc = structuredClone(VALID_ACB);
    doc.intent_groups[0].annotations![0].type = "invalid" as any;
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path.includes("type"));
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/Invalid value "invalid"/);
    }
  });

  it("returns error for invalid view_hint enum", () => {
    const doc = structuredClone(VALID_ACB);
    doc.intent_groups[0].file_refs[0].view_hint = "bad" as any;
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path.includes("view_hint"));
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/Invalid value "bad"/);
    }
  });

  it("returns error for invalid negative_space reason enum", () => {
    const doc = structuredClone(VALID_ACB);
    doc.negative_space![0].reason = "nope" as any;
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path.includes("reason"));
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/Invalid value "nope"/);
    }
  });

  it("returns error for invalid turn role enum", () => {
    const doc = structuredClone(VALID_ACB);
    doc.task_statement.turns[0].role = "admin" as any;
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path.includes("role"));
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/Invalid value "admin"/);
    }
  });

  it("returns error for invalid range format", () => {
    const doc = structuredClone(VALID_ACB);
    doc.intent_groups[0].file_refs[0].ranges = ["0-5"];
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path.includes("ranges"));
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/Invalid range format/);
    }
  });

  it("returns error for range with leading zeros", () => {
    const doc = structuredClone(VALID_ACB);
    doc.intent_groups[0].file_refs[0].ranges = ["01-5"];
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path.includes("ranges"));
      expect(err).toBeDefined();
    }
  });

  it("returns error for empty intent_groups", () => {
    const doc = structuredClone(VALID_ACB);
    doc.intent_groups = [];
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path === "$.intent_groups");
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/must not be empty/);
    }
  });

  it("returns error for empty file_refs in intent group", () => {
    const doc = structuredClone(VALID_ACB);
    doc.intent_groups[0].file_refs = [];
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path.includes("file_refs"));
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/must not be empty/);
    }
  });

  it("returns error for empty turns", () => {
    const doc = structuredClone(VALID_ACB);
    doc.task_statement.turns = [];
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path.includes("turns"));
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/must not be empty/);
    }
  });

  it("returns error for empty ranges", () => {
    const doc = structuredClone(VALID_ACB);
    doc.intent_groups[0].file_refs[0].ranges = [];
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path.includes("ranges"));
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/must not be empty/);
    }
  });

  it("collects multiple errors", () => {
    const doc = {
      acb_version: 123, // wrong type
      // missing id, change_set_ref, task_statement, generated_at
      intent_groups: "not-an-array", // wrong type
    };
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("accepts valid single-line range", () => {
    const doc = structuredClone(VALID_ACB);
    doc.intent_groups[0].file_refs[0].ranges = ["42"];
    const result = parseAcbDocument(JSON.stringify(doc));
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: parseReviewState
// ---------------------------------------------------------------------------

describe("parseReviewState", () => {
  it("parses a valid review state document (Appendix B)", () => {
    const result = parseReviewState(JSON.stringify(VALID_REVIEW));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.acb_version).toBe("0.1");
      expect(result.data.group_verdicts).toHaveLength(2);
      expect(result.data.overall_verdict).toBe("changes_requested");
    }
  });

  it("returns error for invalid JSON", () => {
    const result = parseReviewState("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/Invalid JSON/);
    }
  });

  it("returns errors for missing required fields", () => {
    const result = parseReviewState(JSON.stringify({}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);
      expect(paths).toContain("$.acb_version");
      expect(paths).toContain("$.acb_hash");
      expect(paths).toContain("$.acb_id");
      expect(paths).toContain("$.reviewer");
      expect(paths).toContain("$.group_verdicts");
      expect(paths).toContain("$.overall_verdict");
      expect(paths).toContain("$.updated_at");
    }
  });

  it("returns error for invalid group verdict enum", () => {
    const doc = structuredClone(VALID_REVIEW);
    doc.group_verdicts[0].verdict = "maybe" as any;
    const result = parseReviewState(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path.includes("verdict"));
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/Invalid value "maybe"/);
    }
  });

  it("returns error for invalid overall verdict enum", () => {
    const doc = structuredClone(VALID_REVIEW);
    doc.overall_verdict = "dunno" as any;
    const result = parseReviewState(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) =>
        e.path.includes("overall_verdict"),
      );
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/Invalid value "dunno"/);
    }
  });

  it("collects multiple errors", () => {
    const doc = {
      acb_version: 1,
      overall_verdict: "nope",
    };
    const result = parseReviewState(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
    }
  });
});
