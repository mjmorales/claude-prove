import { describe, it, expect } from "vitest";
import { parseIntentManifest } from "../parser.js";

const VALID_MANIFEST = {
  acb_manifest_version: "0.1",
  commit_sha: "abc1234def5678",
  timestamp: "2026-03-19T14:30:00Z",
  intent_groups: [
    {
      id: "auth-middleware",
      title: "JWT validation middleware",
      classification: "explicit",
      ambiguity_tags: [],
      task_grounding: "Implements token validation as specified in PRD.",
      file_refs: [
        { path: "src/auth.ts", ranges: ["10-45"], view_hint: "changed_region" },
      ],
    },
  ],
};

describe("parseIntentManifest", () => {
  it("parses a valid manifest", () => {
    const result = parseIntentManifest(JSON.stringify(VALID_MANIFEST));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.acb_manifest_version).toBe("0.1");
      expect(result.data.commit_sha).toBe("abc1234def5678");
      expect(result.data.intent_groups).toHaveLength(1);
      expect(result.data.intent_groups[0].id).toBe("auth-middleware");
    }
  });

  it("accepts manifest with optional fields", () => {
    const manifest = {
      ...VALID_MANIFEST,
      negative_space: [
        { path: "src/old.ts", reason: "out_of_scope", explanation: "Not related." },
      ],
      open_questions: [
        {
          id: "q1",
          question: "Should we rotate keys?",
          context: "PRD doesn't specify.",
          default_behavior: "Static JWKS endpoint.",
        },
      ],
      agent_id: "claude-opus-4.6",
    };
    const result = parseIntentManifest(JSON.stringify(manifest));
    expect(result.ok).toBe(true);
  });

  it("rejects invalid JSON", () => {
    const result = parseIntentManifest("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toContain("Invalid JSON");
    }
  });

  it("rejects missing acb_manifest_version", () => {
    const { acb_manifest_version, ...rest } = VALID_MANIFEST;
    const result = parseIntentManifest(JSON.stringify(rest));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("acb_manifest_version"))).toBe(true);
    }
  });

  it("rejects missing commit_sha", () => {
    const { commit_sha, ...rest } = VALID_MANIFEST;
    const result = parseIntentManifest(JSON.stringify(rest));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("commit_sha"))).toBe(true);
    }
  });

  it("rejects missing intent_groups", () => {
    const { intent_groups, ...rest } = VALID_MANIFEST;
    const result = parseIntentManifest(JSON.stringify(rest));
    expect(result.ok).toBe(false);
  });

  it("validates intent group structure", () => {
    const manifest = {
      ...VALID_MANIFEST,
      intent_groups: [
        { id: "bad-group" }, // missing required fields
      ],
    };
    const result = parseIntentManifest(JSON.stringify(manifest));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("validates negative_space entries", () => {
    const manifest = {
      ...VALID_MANIFEST,
      negative_space: [
        { path: "test.ts", reason: "invalid_reason", explanation: "test" },
      ],
    };
    const result = parseIntentManifest(JSON.stringify(manifest));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("invalid_reason"))).toBe(true);
    }
  });

  it("accepts empty intent_groups array", () => {
    const manifest = {
      ...VALID_MANIFEST,
      intent_groups: [],
    };
    // Empty is structurally valid at parse level (semantic validation catches it)
    const result = parseIntentManifest(JSON.stringify(manifest));
    expect(result.ok).toBe(true);
  });
});
