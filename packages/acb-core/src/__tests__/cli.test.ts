import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseAcbDocument } from "../parser.js";
import { validateAcbDocument } from "../validator.js";
import { runValidate } from "../cli/validate.js";
import { runGenerate } from "../cli/generate.js";
import type { AcbDocument } from "../types.js";

const FIXTURES_DIR = join(__dirname, "fixtures");

const VALID_ACB: AcbDocument = {
  acb_version: "0.1",
  id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  change_set_ref: {
    base_ref: "abc1234",
    head_ref: "def5678",
  },
  task_statement: {
    turns: [
      {
        turn_id: "turn-1",
        role: "user",
        content: "Add input validation to the login endpoint.",
      },
    ],
  },
  intent_groups: [
    {
      id: "group-1",
      title: "Add validation to login handler",
      classification: "explicit",
      ambiguity_tags: [],
      task_grounding:
        "Turn turn-1 directly requests input validation for the login endpoint.",
      file_refs: [
        {
          path: "src/auth/login.go",
          ranges: ["15-28"],
          view_hint: "changed_region",
        },
      ],
    },
  ],
  generated_at: "2026-03-19T14:30:00Z",
  agent_id: "test",
};

const INVALID_ACB: AcbDocument = {
  acb_version: "0.1",
  id: "bad-doc",
  change_set_ref: {
    base_ref: "abc",
    head_ref: "def",
  },
  task_statement: {
    turns: [
      {
        turn_id: "turn-1",
        role: "user",
        content: "Do something",
      },
    ],
  },
  intent_groups: [
    {
      id: "group-1",
      title: "Test group",
      classification: "explicit",
      ambiguity_tags: ["scope_creep"], // ACB-9 violation: scope_creep on non-speculative
      task_grounding: "Turn turn-1",
      file_refs: [
        {
          path: "test.ts",
          ranges: ["5-3"], // ACB-13 violation: N > M
        },
      ],
    },
  ],
  generated_at: "2026-03-19T14:30:00Z",
  agent_id: "test",
};

beforeAll(() => {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  writeFileSync(
    join(FIXTURES_DIR, "valid.acb.json"),
    JSON.stringify(VALID_ACB, null, 2),
  );
  writeFileSync(
    join(FIXTURES_DIR, "invalid.acb.json"),
    JSON.stringify(INVALID_ACB, null, 2),
  );
});

afterAll(() => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

describe("parseAcbDocument", () => {
  it("parses a valid ACB document", () => {
    const json = JSON.stringify(VALID_ACB);
    const result = parseAcbDocument(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.acb_version).toBe("0.1");
      expect(result.data.id).toBe("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d");
      expect(result.data.intent_groups).toHaveLength(1);
    }
  });

  it("returns errors on invalid JSON", () => {
    const result = parseAcbDocument("not json");
    expect(result.ok).toBe(false);
  });

  it("returns errors on missing required fields", () => {
    const result = parseAcbDocument("{}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("acb_version"))).toBe(true);
    }
  });
});

describe("validateAcbDocument", () => {
  it("returns all valid for a valid document", () => {
    const results = validateAcbDocument(VALID_ACB);
    const failures = results.filter((r) => !r.valid);
    expect(failures).toHaveLength(0);
  });

  it("detects ACB-9 and ACB-13 violations", () => {
    const results = validateAcbDocument(INVALID_ACB);
    const failures = results.filter((r) => !r.valid);
    const failedRules = failures.map((r) => r.rule);
    expect(failedRules).toContain("ACB-9");
    expect(failedRules).toContain("ACB-13");
  });
});

describe("CLI validate command", () => {
  it("validates a valid ACB file with exit code 0", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      const code = runValidate([join(FIXTURES_DIR, "valid.acb.json")]);
      expect(code).toBe(0);
      expect(logs.some((l) => l.includes("VALID"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  it("validates an invalid ACB file with exit code 1", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      const code = runValidate([join(FIXTURES_DIR, "invalid.acb.json")]);
      expect(code).toBe(1);
      expect(logs.some((l) => l.includes("ACB-9"))).toBe(true);
      expect(logs.some((l) => l.includes("INVALID"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  it("returns exit code 2 for missing file", () => {
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      const code = runValidate(["/nonexistent/file.acb.json"]);
      expect(code).toBe(2);
    } finally {
      console.error = origErr;
    }
  });

  it("outputs JSON with --json flag", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      const code = runValidate([
        join(FIXTURES_DIR, "valid.acb.json"),
        "--json",
      ]);
      expect(code).toBe(0);
      const output = logs.join("\n");
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]).toHaveProperty("rule");
      expect(parsed[0]).toHaveProperty("valid");
    } finally {
      console.log = origLog;
    }
  });
});

describe("CLI generate command", () => {
  it("produces parseable ACB JSON", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      const code = runGenerate([
        "--base",
        "HEAD~1",
        "--head",
        "HEAD",
      ]);
      expect(code).toBe(0);
      const output = logs.join("\n");
      const doc = JSON.parse(output);
      expect(doc.acb_version).toBe("0.1");
      expect(doc.id).toBeTruthy();
      expect(doc.change_set_ref.base_ref).toBe("HEAD~1");
      expect(doc.change_set_ref.head_ref).toBe("HEAD");
      expect(doc.task_statement.turns).toHaveLength(1);
      expect(doc.intent_groups.length).toBeGreaterThanOrEqual(1);
      expect(doc.agent_id).toBe("acb-cli");

      // Verify it parses as a valid ACB document
      const parsed = parseAcbDocument(JSON.stringify(doc));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const results = validateAcbDocument(parsed.data);
        const failures = results.filter((r) => !r.valid);
        expect(failures).toHaveLength(0);
      }
    } finally {
      console.log = origLog;
    }
  });
});
