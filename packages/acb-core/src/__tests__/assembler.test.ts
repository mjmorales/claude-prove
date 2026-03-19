import { describe, it, expect } from "vitest";
import { assemble } from "../assembler.js";
import type { IntentManifest } from "../types.js";

function makeManifest(overrides: Partial<IntentManifest> = {}): IntentManifest {
  return {
    acb_manifest_version: "0.1",
    commit_sha: "abc1234",
    timestamp: "2026-03-19T14:00:00Z",
    intent_groups: [
      {
        id: "group-1",
        title: "Test change",
        classification: "explicit",
        ambiguity_tags: [],
        task_grounding: "Directly requested.",
        file_refs: [
          { path: "src/main.ts", ranges: ["1-10"], view_hint: "changed_region" },
        ],
      },
    ],
    ...overrides,
  };
}

const BASE_OPTIONS = {
  base_ref: "abc1234",
  head_ref: "def5678",
};

describe("assemble", () => {
  it("assembles a single manifest into a valid ACB", () => {
    const manifest = makeManifest();
    const { document, warnings } = assemble([manifest], BASE_OPTIONS);

    expect(document.acb_version).toBe("0.1");
    expect(document.id).toBeTruthy();
    expect(document.change_set_ref.base_ref).toBe("abc1234");
    expect(document.change_set_ref.head_ref).toBe("def5678");
    expect(document.intent_groups).toHaveLength(1);
    expect(document.intent_groups[0].id).toBe("group-1");
    expect(document.intent_groups[0].file_refs[0].path).toBe("src/main.ts");
    expect(warnings).toHaveLength(0);
  });

  it("merges groups with same id across manifests", () => {
    const m1 = makeManifest({
      timestamp: "2026-03-19T14:00:00Z",
      intent_groups: [
        {
          id: "auth",
          title: "Auth middleware",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "Requested in PRD.",
          file_refs: [{ path: "src/auth.ts", ranges: ["1-20"] }],
        },
      ],
    });

    const m2 = makeManifest({
      commit_sha: "def5678",
      timestamp: "2026-03-19T15:00:00Z",
      intent_groups: [
        {
          id: "auth",
          title: "Auth middleware",
          classification: "explicit",
          ambiguity_tags: ["assumption"],
          task_grounding: "Requested in PRD.",
          file_refs: [{ path: "src/auth.ts", ranges: ["25-40"] }],
        },
      ],
    });

    const { document } = assemble([m1, m2], BASE_OPTIONS);

    expect(document.intent_groups).toHaveLength(1);
    const group = document.intent_groups[0];
    expect(group.id).toBe("auth");
    // File refs should be merged — lines 1-20 and 25-40
    expect(group.file_refs[0].path).toBe("src/auth.ts");
    expect(group.file_refs[0].ranges).toContain("1-20");
    expect(group.file_refs[0].ranges).toContain("25-40");
    // Ambiguity tags should be union
    expect(group.ambiguity_tags).toContain("assumption");
  });

  it("keeps distinct groups from different manifests", () => {
    const m1 = makeManifest({
      timestamp: "2026-03-19T14:00:00Z",
      intent_groups: [
        {
          id: "auth",
          title: "Auth middleware",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "Requested.",
          file_refs: [{ path: "src/auth.ts", ranges: ["1-20"] }],
        },
      ],
    });

    const m2 = makeManifest({
      commit_sha: "def5678",
      timestamp: "2026-03-19T15:00:00Z",
      intent_groups: [
        {
          id: "tests",
          title: "Auth tests",
          classification: "inferred",
          ambiguity_tags: [],
          task_grounding: "Tests for new auth code.",
          file_refs: [{ path: "src/auth.test.ts", ranges: ["1-50"] }],
        },
      ],
    });

    const { document } = assemble([m1, m2], BASE_OPTIONS);

    expect(document.intent_groups).toHaveLength(2);
    expect(document.intent_groups[0].id).toBe("auth");
    expect(document.intent_groups[1].id).toBe("tests");
  });

  it("merges negative space entries across manifests", () => {
    const m1 = makeManifest({
      negative_space: [
        { path: "src/old.ts", reason: "out_of_scope", explanation: "Not related." },
      ],
    });

    const m2 = makeManifest({
      commit_sha: "def5678",
      timestamp: "2026-03-19T15:00:00Z",
      negative_space: [
        { path: "src/legacy.ts", reason: "intentionally_preserved", explanation: "Too risky." },
      ],
    });

    const { document } = assemble([m1, m2], BASE_OPTIONS);

    expect(document.negative_space).toHaveLength(2);
  });

  it("deduplicates negative space by path+reason", () => {
    const m1 = makeManifest({
      negative_space: [
        { path: "src/old.ts", reason: "out_of_scope", explanation: "Not related." },
      ],
    });

    const m2 = makeManifest({
      commit_sha: "def5678",
      timestamp: "2026-03-19T15:00:00Z",
      negative_space: [
        { path: "src/old.ts", reason: "out_of_scope", explanation: "Still not related." },
      ],
    });

    const { document } = assemble([m1, m2], BASE_OPTIONS);

    expect(document.negative_space).toHaveLength(1);
  });

  it("warns on empty manifests array", () => {
    const { document, warnings } = assemble([], BASE_OPTIONS);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe("empty_manifests");
    expect(document.intent_groups).toHaveLength(1);
    expect(document.intent_groups[0].id).toBe("uncategorized");
  });

  it("merges overlapping file ranges", () => {
    const m1 = makeManifest({
      intent_groups: [
        {
          id: "refactor",
          title: "Refactor utils",
          classification: "speculative",
          ambiguity_tags: ["scope_creep"],
          task_grounding: "Cleanup.",
          file_refs: [{ path: "src/utils.ts", ranges: ["1-10"] }],
        },
      ],
    });

    const m2 = makeManifest({
      commit_sha: "def5678",
      timestamp: "2026-03-19T15:00:00Z",
      intent_groups: [
        {
          id: "refactor",
          title: "Refactor utils",
          classification: "speculative",
          ambiguity_tags: ["scope_creep"],
          task_grounding: "Cleanup.",
          file_refs: [{ path: "src/utils.ts", ranges: ["8-20"] }],
        },
      ],
    });

    const { document } = assemble([m1, m2], BASE_OPTIONS);

    // Ranges 1-10 and 8-20 should merge to 1-20
    expect(document.intent_groups[0].file_refs[0].ranges).toEqual(["1-20"]);
  });

  it("preserves chronological order of first-seen groups", () => {
    const m1 = makeManifest({
      timestamp: "2026-03-19T16:00:00Z", // later timestamp
      intent_groups: [
        {
          id: "second",
          title: "Second group",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "Second.",
          file_refs: [{ path: "b.ts", ranges: ["1"] }],
        },
      ],
    });

    const m2 = makeManifest({
      commit_sha: "earlier",
      timestamp: "2026-03-19T14:00:00Z", // earlier timestamp
      intent_groups: [
        {
          id: "first",
          title: "First group",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "First.",
          file_refs: [{ path: "a.ts", ranges: ["1"] }],
        },
      ],
    });

    // Pass them in wrong order — assembler should sort by timestamp
    const { document } = assemble([m1, m2], BASE_OPTIONS);

    expect(document.intent_groups[0].id).toBe("first");
    expect(document.intent_groups[1].id).toBe("second");
  });

  it("uses provided task statement", () => {
    const manifest = makeManifest();
    const { document } = assemble([manifest], {
      ...BASE_OPTIONS,
      task_statement: {
        turns: [
          { turn_id: "t1", role: "user", content: "Build the auth system." },
        ],
      },
    });

    expect(document.task_statement.turns[0].content).toBe("Build the auth system.");
  });

  it("merges annotations with deduplication by id", () => {
    const m1 = makeManifest({
      intent_groups: [
        {
          id: "feat",
          title: "Feature",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "Requested.",
          file_refs: [{ path: "src/a.ts", ranges: ["1-5"] }],
          annotations: [
            { id: "ann-1", type: "note", body: "First note." },
          ],
        },
      ],
    });

    const m2 = makeManifest({
      commit_sha: "def5678",
      timestamp: "2026-03-19T15:00:00Z",
      intent_groups: [
        {
          id: "feat",
          title: "Feature",
          classification: "explicit",
          ambiguity_tags: [],
          task_grounding: "Requested.",
          file_refs: [{ path: "src/b.ts", ranges: ["1-5"] }],
          annotations: [
            { id: "ann-1", type: "note", body: "Duplicate." },
            { id: "ann-2", type: "flag", body: "New flag." },
          ],
        },
      ],
    });

    const { document } = assemble([m1, m2], BASE_OPTIONS);

    const annotations = document.intent_groups[0].annotations!;
    expect(annotations).toHaveLength(2);
    expect(annotations[0].id).toBe("ann-1");
    expect(annotations[0].body).toBe("First note."); // first-commit wins
    expect(annotations[1].id).toBe("ann-2");
  });
});
