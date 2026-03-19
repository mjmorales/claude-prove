import { describe, it, expect } from "vitest";
import type {
  AcbDocument,
  ReviewStateDocument,
  IntentGroup,
} from "../types.js";
import {
  validateAcb1,
  validateAcb2,
  validateAcb3,
  validateAcb4,
  validateAcb5,
  validateAcb6,
  validateAcb7,
  validateAcb8,
  validateAcb9,
  validateAcb10,
  validateAcb11,
  validateAcb12,
  validateAcb13,
  validateRev1,
  validateRev2,
  validateRev3,
  validateRev4,
  validateRev5,
  validateRev6,
  validateAcbDocument,
  validateAcbDocumentWithDiff,
  validateReviewState,
  type ChangedFile,
} from "../validator.js";

/** Build a minimal valid ACB document for testing. */
function makeDoc(overrides?: Partial<AcbDocument>): AcbDocument {
  return {
    acb_version: "0.1",
    id: "acb-001",
    change_set_ref: { base_ref: "abc123", head_ref: "def456" },
    task_statement: {
      turns: [
        { turn_id: "t1", role: "user", content: "Implement feature X" },
      ],
    },
    intent_groups: [
      {
        id: "g1",
        title: "Implement feature X",
        classification: "explicit",
        ambiguity_tags: [],
        task_grounding: "As requested in turn t1",
        file_refs: [{ path: "src/foo.ts", ranges: ["1-10"] }],
      },
    ],
    generated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeReview(
  overrides?: Partial<ReviewStateDocument>,
): ReviewStateDocument {
  return {
    acb_version: "0.1",
    acb_hash:
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    acb_id: "acb-001",
    reviewer: "alice",
    group_verdicts: [{ group_id: "g1", verdict: "accepted" }],
    overall_verdict: "approved",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// --- ACB-1: Complete coverage ---

describe("ACB-1: Complete coverage", () => {
  it("passes when no diff info provided (skips with warning)", () => {
    const results = validateAcb1(makeDoc());
    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(true);
    expect(results[0].message).toContain("Skipped");
  });

  it("passes when all changed lines are covered", () => {
    const doc = makeDoc();
    const changed: ChangedFile[] = [
      { path: "src/foo.ts", ranges: ["1-10"] },
    ];
    const results = validateAcb1(doc, changed);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails when a changed line is not covered", () => {
    const doc = makeDoc();
    const changed: ChangedFile[] = [
      { path: "src/foo.ts", ranges: ["11-20"] },
    ];
    const results = validateAcb1(doc, changed);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- ACB-2: Explicit grounding ---

describe("ACB-2: Explicit grounding", () => {
  it("passes for explicit group with grounding referencing turn_id", () => {
    const results = validateAcb2(makeDoc());
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for explicit group with empty task_grounding", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
        },
      ],
    });
    const results = validateAcb2(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- ACB-3: Non-empty grounding ---

describe("ACB-3: Non-empty grounding", () => {
  it("passes for inferred group with non-empty grounding", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "inferred",
          ambiguity_tags: [],
          task_grounding: "Inferred from context",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
        },
      ],
    });
    const results = validateAcb3(doc);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for speculative group with empty grounding", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "speculative",
          ambiguity_tags: [],
          task_grounding: "",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
        },
      ],
    });
    const results = validateAcb3(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- ACB-4: Judgment call tags ---

describe("ACB-4: Judgment call tags", () => {
  it("passes for judgment_call with valid ambiguity_tags", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
          annotations: [
            {
              id: "a1",
              type: "judgment_call",
              body: "Chose approach A",
              ambiguity_tags: ["assumption"],
            },
          ],
        },
      ],
    });
    const results = validateAcb4(doc);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for judgment_call without ambiguity_tags", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
          annotations: [
            {
              id: "a1",
              type: "judgment_call",
              body: "Chose approach A",
            },
          ],
        },
      ],
    });
    const results = validateAcb4(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });

  it("fails for judgment_call with empty ambiguity_tags array", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
          annotations: [
            {
              id: "a1",
              type: "judgment_call",
              body: "Chose approach A",
              ambiguity_tags: [],
            },
          ],
        },
      ],
    });
    const results = validateAcb4(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- ACB-5: Causal link targets exist ---

describe("ACB-5: Causal link targets exist", () => {
  it("passes when all causal links reference existing groups", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "A",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
          causal_links: [{ target_group_id: "g2", rationale: "depends" }],
        },
        {
          id: "g2",
          title: "B",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "b.ts", ranges: ["1"] }],
        },
      ],
    });
    const results = validateAcb5(doc);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails when causal link references non-existent group", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "A",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
          causal_links: [
            { target_group_id: "nonexistent", rationale: "depends" },
          ],
        },
      ],
    });
    const results = validateAcb5(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- ACB-6: Unique identifiers ---

describe("ACB-6: Unique identifiers", () => {
  it("passes when all ids are unique", () => {
    const results = validateAcb6(makeDoc());
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails with duplicate ids across groups and annotations", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "dup",
          title: "A",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
          annotations: [
            { id: "dup", type: "note", body: "note" },
          ],
        },
      ],
    });
    const results = validateAcb6(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });

  it("fails with duplicate ids between group and open question", () => {
    const doc = makeDoc({
      open_questions: [
        {
          id: "g1",
          question: "Q?",
          context: "ctx",
          default_behavior: "skip",
        },
      ],
    });
    const results = validateAcb6(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- ACB-7: Verbatim task ---

describe("ACB-7: Verbatim task", () => {
  it("passes for valid task statement", () => {
    const results = validateAcb7(makeDoc());
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for empty turns array", () => {
    const doc = makeDoc({ task_statement: { turns: [] } });
    const results = validateAcb7(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });

  it("fails for turn with empty content", () => {
    const doc = makeDoc({
      task_statement: {
        turns: [{ turn_id: "t1", role: "user", content: "" }],
      },
    });
    const results = validateAcb7(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- ACB-8: Acyclic causal graph ---

describe("ACB-8: Acyclic causal graph", () => {
  it("passes for acyclic causal graph", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "A",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
          causal_links: [{ target_group_id: "g2", rationale: "depends" }],
        },
        {
          id: "g2",
          title: "B",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "b.ts", ranges: ["1"] }],
        },
      ],
    });
    const results = validateAcb8(doc);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for circular causal links (A→B→C→A)", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "gA",
          title: "A",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
          causal_links: [{ target_group_id: "gB", rationale: "dep" }],
        },
        {
          id: "gB",
          title: "B",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "b.ts", ranges: ["1"] }],
          causal_links: [{ target_group_id: "gC", rationale: "dep" }],
        },
        {
          id: "gC",
          title: "C",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "c.ts", ranges: ["1"] }],
          causal_links: [{ target_group_id: "gA", rationale: "dep" }],
        },
      ],
    });
    const results = validateAcb8(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
    expect(results[0].message).toContain("cycle");
  });
});

// --- ACB-9: Scope creep constraint ---

describe("ACB-9: Scope creep constraint", () => {
  it("passes for scope_creep on speculative classification", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "speculative",
          ambiguity_tags: ["scope_creep"],
          task_grounding: "Might be useful",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
        },
      ],
    });
    const results = validateAcb9(doc);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for scope_creep on explicit classification", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "explicit",
          ambiguity_tags: ["scope_creep"],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
        },
      ],
    });
    const results = validateAcb9(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });

  it("fails for scope_creep on inferred classification", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "inferred",
          ambiguity_tags: ["scope_creep"],
          task_grounding: "Inferred from context",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
        },
      ],
    });
    const results = validateAcb9(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- ACB-10: Open question references ---

describe("ACB-10: Open question references", () => {
  it("passes when all related_group_ids exist", () => {
    const doc = makeDoc({
      open_questions: [
        {
          id: "q1",
          question: "Q?",
          context: "ctx",
          default_behavior: "skip",
          related_group_ids: ["g1"],
        },
      ],
    });
    const results = validateAcb10(doc);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails when related_group_ids references non-existent group", () => {
    const doc = makeDoc({
      open_questions: [
        {
          id: "q1",
          question: "Q?",
          context: "ctx",
          default_behavior: "skip",
          related_group_ids: ["nonexistent"],
        },
      ],
    });
    const results = validateAcb10(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- ACB-11: Non-empty intent groups ---

describe("ACB-11: Non-empty intent groups", () => {
  it("passes for non-empty intent_groups", () => {
    const results = validateAcb11(makeDoc());
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for empty intent_groups", () => {
    const doc = makeDoc({ intent_groups: [] });
    const results = validateAcb11(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- ACB-12: Non-empty file refs ---

describe("ACB-12: Non-empty file refs", () => {
  it("passes for group with file_refs", () => {
    const results = validateAcb12(makeDoc());
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for group with empty file_refs", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [],
        },
      ],
    });
    const results = validateAcb12(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- ACB-13: Valid range format ---

describe("ACB-13: Valid range format", () => {
  it("passes for valid ranges", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["1", "5-10", "1-10"] }],
        },
      ],
    });
    const results = validateAcb13(doc);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for range starting with 0", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["0"] }],
        },
      ],
    });
    const results = validateAcb13(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });

  it("fails for range with start > end (5-3)", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["5-3"] }],
        },
      ],
    });
    const results = validateAcb13(doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });

  it("passes for valid range 1-10", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "X",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["1-10"] }],
        },
      ],
    });
    const results = validateAcb13(doc);
    expect(results.every((r) => r.valid)).toBe(true);
  });
});

// --- REV-1: Valid hash format ---

describe("REV-1: Valid hash format", () => {
  it("passes for valid 64-char lowercase hex hash", () => {
    const results = validateRev1(makeReview());
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for hash with uppercase letters", () => {
    const review = makeReview({
      acb_hash:
        "ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    });
    const results = validateRev1(review);
    expect(results.some((r) => !r.valid)).toBe(true);
  });

  it("fails for short hash", () => {
    const review = makeReview({ acb_hash: "abcdef" });
    const results = validateRev1(review);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- REV-2: Complete group coverage ---

describe("REV-2: Complete group coverage", () => {
  it("passes when group_verdicts match intent groups exactly", () => {
    const doc = makeDoc();
    const review = makeReview();
    const results = validateRev2(review, doc);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails when missing a group verdict", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "A",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
        },
        {
          id: "g2",
          title: "B",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "b.ts", ranges: ["1"] }],
        },
      ],
    });
    const review = makeReview({
      group_verdicts: [{ group_id: "g1", verdict: "accepted" }],
    });
    const results = validateRev2(review, doc);
    expect(results.some((r) => !r.valid)).toBe(true);
    expect(results.some((r) => r.message?.includes("Missing"))).toBe(true);
  });

  it("fails when extra group verdict present", () => {
    const doc = makeDoc();
    const review = makeReview({
      group_verdicts: [
        { group_id: "g1", verdict: "accepted" },
        { group_id: "g_extra", verdict: "accepted" },
      ],
    });
    const results = validateRev2(review, doc);
    expect(results.some((r) => !r.valid)).toBe(true);
    expect(results.some((r) => r.message?.includes("Extra"))).toBe(true);
  });
});

// --- REV-3: Valid verdict values ---

describe("REV-3: Valid verdict values", () => {
  it("passes for valid verdict values", () => {
    const results = validateRev3(makeReview());
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for invalid group verdict", () => {
    const review = makeReview({
      group_verdicts: [
        { group_id: "g1", verdict: "invalid" as any },
      ],
    });
    const results = validateRev3(review);
    expect(results.some((r) => !r.valid)).toBe(true);
  });

  it("fails for invalid overall verdict", () => {
    const review = makeReview({ overall_verdict: "invalid" as any });
    const results = validateRev3(review);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- REV-4: Annotation response targets ---

describe("REV-4: Annotation response targets", () => {
  it("passes when annotation responses reference existing annotations", () => {
    const doc = makeDoc({
      intent_groups: [
        {
          id: "g1",
          title: "A",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "turn t1",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
          annotations: [{ id: "a1", type: "note", body: "note" }],
        },
      ],
    });
    const review = makeReview({
      group_verdicts: [
        {
          group_id: "g1",
          verdict: "accepted",
          annotation_responses: [
            { annotation_id: "a1", response: "ok" },
          ],
        },
      ],
    });
    const results = validateRev4(review, doc);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for annotation response referencing non-existent annotation", () => {
    const doc = makeDoc();
    const review = makeReview({
      group_verdicts: [
        {
          group_id: "g1",
          verdict: "accepted",
          annotation_responses: [
            { annotation_id: "nonexistent", response: "ok" },
          ],
        },
      ],
    });
    const results = validateRev4(review, doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- REV-5: Question answer targets ---

describe("REV-5: Question answer targets", () => {
  it("passes when question answers reference existing questions", () => {
    const doc = makeDoc({
      open_questions: [
        {
          id: "q1",
          question: "Q?",
          context: "ctx",
          default_behavior: "skip",
        },
      ],
    });
    const review = makeReview({
      question_answers: [{ question_id: "q1", answer: "A" }],
    });
    const results = validateRev5(review, doc);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for question answer referencing non-existent question", () => {
    const doc = makeDoc();
    const review = makeReview({
      question_answers: [{ question_id: "nonexistent", answer: "A" }],
    });
    const results = validateRev5(review, doc);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- REV-6: Non-empty reviewer ---

describe("REV-6: Non-empty reviewer", () => {
  it("passes for non-empty reviewer", () => {
    const results = validateRev6(makeReview());
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it("fails for empty reviewer", () => {
    const review = makeReview({ reviewer: "" });
    const results = validateRev6(review);
    expect(results.some((r) => !r.valid)).toBe(true);
  });

  it("fails for whitespace-only reviewer", () => {
    const review = makeReview({ reviewer: "   " });
    const results = validateRev6(review);
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});

// --- Aggregate validators ---

describe("validateAcbDocument", () => {
  it("returns all passing results for a valid document", () => {
    const results = validateAcbDocument(makeDoc());
    expect(results.every((r) => r.valid)).toBe(true);
    // Should have results from ACB-2 through ACB-13 (12 rules)
    const rules = new Set(results.map((r) => r.rule));
    expect(rules.size).toBe(12);
  });
});

describe("validateAcbDocumentWithDiff", () => {
  it("includes ACB-1 in results", () => {
    const doc = makeDoc();
    const changed: ChangedFile[] = [
      { path: "src/foo.ts", ranges: ["1-10"] },
    ];
    const results = validateAcbDocumentWithDiff(doc, changed);
    const rules = new Set(results.map((r) => r.rule));
    expect(rules.has("ACB-1")).toBe(true);
    expect(rules.size).toBe(13);
  });
});

describe("validateReviewState", () => {
  it("returns all passing results for valid review", () => {
    const results = validateReviewState(makeReview(), makeDoc());
    expect(results.every((r) => r.valid)).toBe(true);
    const rules = new Set(results.map((r) => r.rule));
    expect(rules.size).toBe(6);
  });
});
