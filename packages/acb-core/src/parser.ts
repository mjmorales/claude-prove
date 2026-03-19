/**
 * Structural parser for ACB (.acb.json) and Review State (.acb-review.json) documents.
 * Validates required fields, types, enum values, and formats.
 * Does NOT implement the 19 semantic validation rules from the spec.
 */

import type {
  AcbDocument,
  IntentManifest,
  ReviewStateDocument,
  ParseResult,
  ParseError,
} from "./types.js";

import {
  CLASSIFICATIONS,
  AMBIGUITY_TAGS,
  ANNOTATION_TYPES,
  VIEW_HINTS,
  NEGATIVE_SPACE_REASONS,
  TURN_ROLES,
  GROUP_VERDICT_VALUES,
  OVERALL_VERDICT_VALUES,
} from "./types.js";

const RANGE_RE = /^[1-9][0-9]*(-[1-9][0-9]*)?$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Validator = (value: unknown, path: string, errors: ParseError[]) => void;

function requireField(
  obj: Record<string, unknown>,
  field: string,
  path: string,
  errors: ParseError[],
): unknown {
  if (!(field in obj) || obj[field] === undefined) {
    errors.push({ path: `${path}.${field}`, message: `Missing required field "${field}"` });
    return undefined;
  }
  return obj[field];
}

function checkType(
  value: unknown,
  expected: string,
  path: string,
  errors: ParseError[],
): boolean {
  if (expected === "array") {
    if (!Array.isArray(value)) {
      errors.push({ path, message: `Expected array, got ${typeof value}` });
      return false;
    }
    return true;
  }
  if (expected === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push({ path, message: `Expected object, got ${Array.isArray(value) ? "array" : typeof value}` });
      return false;
    }
    return true;
  }
  if (typeof value !== expected) {
    errors.push({ path, message: `Expected ${expected}, got ${typeof value}` });
    return false;
  }
  return true;
}

function checkEnum(
  value: unknown,
  allowed: readonly string[],
  path: string,
  errors: ParseError[],
): void {
  if (typeof value !== "string") return; // type error already reported
  if (!allowed.includes(value)) {
    errors.push({ path, message: `Invalid value "${value}". Must be one of: ${allowed.join(", ")}` });
  }
}

function checkNonEmptyArray(
  value: unknown,
  path: string,
  errors: ParseError[],
): boolean {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) {
    errors.push({ path, message: "Array must not be empty" });
    return false;
  }
  return true;
}

function checkRange(value: unknown, path: string, errors: ParseError[]): void {
  if (typeof value !== "string") return;
  if (!RANGE_RE.test(value)) {
    errors.push({ path, message: `Invalid range format "${value}". Must match ${RANGE_RE.source}` });
  }
}

// ---------------------------------------------------------------------------
// Sub-structure validators
// ---------------------------------------------------------------------------

function validateFileRef(obj: unknown, path: string, errors: ParseError[]): void {
  if (!checkType(obj, "object", path, errors)) return;
  const o = obj as Record<string, unknown>;

  const p = requireField(o, "path", path, errors);
  if (p !== undefined) checkType(p, "string", `${path}.path`, errors);

  const ranges = requireField(o, "ranges", path, errors);
  if (ranges !== undefined) {
    if (checkType(ranges, "array", `${path}.ranges`, errors)) {
      if (checkNonEmptyArray(ranges, `${path}.ranges`, errors)) {
        (ranges as unknown[]).forEach((r, i) => {
          if (checkType(r, "string", `${path}.ranges[${i}]`, errors)) {
            checkRange(r, `${path}.ranges[${i}]`, errors);
          }
        });
      }
    }
  }

  if ("view_hint" in o && o.view_hint !== undefined) {
    if (checkType(o.view_hint, "string", `${path}.view_hint`, errors)) {
      checkEnum(o.view_hint, VIEW_HINTS, `${path}.view_hint`, errors);
    }
  }
}

function validateCausalLink(obj: unknown, path: string, errors: ParseError[]): void {
  if (!checkType(obj, "object", path, errors)) return;
  const o = obj as Record<string, unknown>;

  const tid = requireField(o, "target_group_id", path, errors);
  if (tid !== undefined) checkType(tid, "string", `${path}.target_group_id`, errors);

  const rat = requireField(o, "rationale", path, errors);
  if (rat !== undefined) checkType(rat, "string", `${path}.rationale`, errors);
}

function validateAnnotation(obj: unknown, path: string, errors: ParseError[]): void {
  if (!checkType(obj, "object", path, errors)) return;
  const o = obj as Record<string, unknown>;

  const id = requireField(o, "id", path, errors);
  if (id !== undefined) checkType(id, "string", `${path}.id`, errors);

  const type = requireField(o, "type", path, errors);
  if (type !== undefined) {
    if (checkType(type, "string", `${path}.type`, errors)) {
      checkEnum(type, ANNOTATION_TYPES, `${path}.type`, errors);
    }
  }

  const body = requireField(o, "body", path, errors);
  if (body !== undefined) checkType(body, "string", `${path}.body`, errors);

  if ("ambiguity_tags" in o && o.ambiguity_tags !== undefined) {
    if (checkType(o.ambiguity_tags, "array", `${path}.ambiguity_tags`, errors)) {
      (o.ambiguity_tags as unknown[]).forEach((t, i) => {
        if (checkType(t, "string", `${path}.ambiguity_tags[${i}]`, errors)) {
          checkEnum(t, AMBIGUITY_TAGS, `${path}.ambiguity_tags[${i}]`, errors);
        }
      });
    }
  }

  if ("file_refs" in o && o.file_refs !== undefined) {
    if (checkType(o.file_refs, "array", `${path}.file_refs`, errors)) {
      (o.file_refs as unknown[]).forEach((fr, i) => validateFileRef(fr, `${path}.file_refs[${i}]`, errors));
    }
  }

  if ("causal_links" in o && o.causal_links !== undefined) {
    if (checkType(o.causal_links, "array", `${path}.causal_links`, errors)) {
      (o.causal_links as unknown[]).forEach((cl, i) => validateCausalLink(cl, `${path}.causal_links[${i}]`, errors));
    }
  }
}

function validateTurn(obj: unknown, path: string, errors: ParseError[]): void {
  if (!checkType(obj, "object", path, errors)) return;
  const o = obj as Record<string, unknown>;

  const tid = requireField(o, "turn_id", path, errors);
  if (tid !== undefined) checkType(tid, "string", `${path}.turn_id`, errors);

  const role = requireField(o, "role", path, errors);
  if (role !== undefined) {
    if (checkType(role, "string", `${path}.role`, errors)) {
      checkEnum(role, TURN_ROLES, `${path}.role`, errors);
    }
  }

  const content = requireField(o, "content", path, errors);
  if (content !== undefined) checkType(content, "string", `${path}.content`, errors);

  if ("timestamp" in o && o.timestamp !== undefined) {
    checkType(o.timestamp, "string", `${path}.timestamp`, errors);
  }
}

function validateIntentGroup(obj: unknown, path: string, errors: ParseError[]): void {
  if (!checkType(obj, "object", path, errors)) return;
  const o = obj as Record<string, unknown>;

  const id = requireField(o, "id", path, errors);
  if (id !== undefined) checkType(id, "string", `${path}.id`, errors);

  const title = requireField(o, "title", path, errors);
  if (title !== undefined) checkType(title, "string", `${path}.title`, errors);

  const cls = requireField(o, "classification", path, errors);
  if (cls !== undefined) {
    if (checkType(cls, "string", `${path}.classification`, errors)) {
      checkEnum(cls, CLASSIFICATIONS, `${path}.classification`, errors);
    }
  }

  const atags = requireField(o, "ambiguity_tags", path, errors);
  if (atags !== undefined) {
    if (checkType(atags, "array", `${path}.ambiguity_tags`, errors)) {
      (atags as unknown[]).forEach((t, i) => {
        if (checkType(t, "string", `${path}.ambiguity_tags[${i}]`, errors)) {
          checkEnum(t, AMBIGUITY_TAGS, `${path}.ambiguity_tags[${i}]`, errors);
        }
      });
    }
  }

  const tg = requireField(o, "task_grounding", path, errors);
  if (tg !== undefined) checkType(tg, "string", `${path}.task_grounding`, errors);

  const frefs = requireField(o, "file_refs", path, errors);
  if (frefs !== undefined) {
    if (checkType(frefs, "array", `${path}.file_refs`, errors)) {
      if (checkNonEmptyArray(frefs, `${path}.file_refs`, errors)) {
        (frefs as unknown[]).forEach((fr, i) => validateFileRef(fr, `${path}.file_refs[${i}]`, errors));
      }
    }
  }

  if ("annotations" in o && o.annotations !== undefined) {
    if (checkType(o.annotations, "array", `${path}.annotations`, errors)) {
      (o.annotations as unknown[]).forEach((a, i) => validateAnnotation(a, `${path}.annotations[${i}]`, errors));
    }
  }

  if ("causal_links" in o && o.causal_links !== undefined) {
    if (checkType(o.causal_links, "array", `${path}.causal_links`, errors)) {
      (o.causal_links as unknown[]).forEach((cl, i) => validateCausalLink(cl, `${path}.causal_links[${i}]`, errors));
    }
  }
}

function validateOpenQuestion(obj: unknown, path: string, errors: ParseError[]): void {
  if (!checkType(obj, "object", path, errors)) return;
  const o = obj as Record<string, unknown>;

  const id = requireField(o, "id", path, errors);
  if (id !== undefined) checkType(id, "string", `${path}.id`, errors);

  const q = requireField(o, "question", path, errors);
  if (q !== undefined) checkType(q, "string", `${path}.question`, errors);

  const ctx = requireField(o, "context", path, errors);
  if (ctx !== undefined) checkType(ctx, "string", `${path}.context`, errors);

  const db = requireField(o, "default_behavior", path, errors);
  if (db !== undefined) checkType(db, "string", `${path}.default_behavior`, errors);

  if ("related_group_ids" in o && o.related_group_ids !== undefined) {
    if (checkType(o.related_group_ids, "array", `${path}.related_group_ids`, errors)) {
      (o.related_group_ids as unknown[]).forEach((v, i) => {
        checkType(v, "string", `${path}.related_group_ids[${i}]`, errors);
      });
    }
  }

  if ("related_paths" in o && o.related_paths !== undefined) {
    if (checkType(o.related_paths, "array", `${path}.related_paths`, errors)) {
      (o.related_paths as unknown[]).forEach((v, i) => {
        checkType(v, "string", `${path}.related_paths[${i}]`, errors);
      });
    }
  }
}

function validateNegativeSpaceEntry(obj: unknown, path: string, errors: ParseError[]): void {
  if (!checkType(obj, "object", path, errors)) return;
  const o = obj as Record<string, unknown>;

  const p = requireField(o, "path", path, errors);
  if (p !== undefined) checkType(p, "string", `${path}.path`, errors);

  const reason = requireField(o, "reason", path, errors);
  if (reason !== undefined) {
    if (checkType(reason, "string", `${path}.reason`, errors)) {
      checkEnum(reason, NEGATIVE_SPACE_REASONS, `${path}.reason`, errors);
    }
  }

  const exp = requireField(o, "explanation", path, errors);
  if (exp !== undefined) checkType(exp, "string", `${path}.explanation`, errors);

  if ("ranges" in o && o.ranges !== undefined) {
    if (checkType(o.ranges, "array", `${path}.ranges`, errors)) {
      (o.ranges as unknown[]).forEach((r, i) => {
        if (checkType(r, "string", `${path}.ranges[${i}]`, errors)) {
          checkRange(r, `${path}.ranges[${i}]`, errors);
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Review State sub-validators
// ---------------------------------------------------------------------------

function validateAnnotationResponse(obj: unknown, path: string, errors: ParseError[]): void {
  if (!checkType(obj, "object", path, errors)) return;
  const o = obj as Record<string, unknown>;

  const aid = requireField(o, "annotation_id", path, errors);
  if (aid !== undefined) checkType(aid, "string", `${path}.annotation_id`, errors);

  const resp = requireField(o, "response", path, errors);
  if (resp !== undefined) checkType(resp, "string", `${path}.response`, errors);
}

function validateGroupVerdict(obj: unknown, path: string, errors: ParseError[]): void {
  if (!checkType(obj, "object", path, errors)) return;
  const o = obj as Record<string, unknown>;

  const gid = requireField(o, "group_id", path, errors);
  if (gid !== undefined) checkType(gid, "string", `${path}.group_id`, errors);

  const verdict = requireField(o, "verdict", path, errors);
  if (verdict !== undefined) {
    if (checkType(verdict, "string", `${path}.verdict`, errors)) {
      checkEnum(verdict, GROUP_VERDICT_VALUES, `${path}.verdict`, errors);
    }
  }

  if ("comment" in o && o.comment !== undefined) {
    checkType(o.comment, "string", `${path}.comment`, errors);
  }

  if ("annotation_responses" in o && o.annotation_responses !== undefined) {
    if (checkType(o.annotation_responses, "array", `${path}.annotation_responses`, errors)) {
      (o.annotation_responses as unknown[]).forEach((ar, i) =>
        validateAnnotationResponse(ar, `${path}.annotation_responses[${i}]`, errors),
      );
    }
  }
}

function validateQuestionAnswer(obj: unknown, path: string, errors: ParseError[]): void {
  if (!checkType(obj, "object", path, errors)) return;
  const o = obj as Record<string, unknown>;

  const qid = requireField(o, "question_id", path, errors);
  if (qid !== undefined) checkType(qid, "string", `${path}.question_id`, errors);

  const ans = requireField(o, "answer", path, errors);
  if (ans !== undefined) checkType(ans, "string", `${path}.answer`, errors);
}

// ---------------------------------------------------------------------------
// Top-level parsers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string into a validated AcbDocument.
 * Returns all structural errors collected, not just the first.
 */
export function parseAcbDocument(json: string): ParseResult<AcbDocument> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, errors: [{ path: "$", message: `Invalid JSON: ${(e as Error).message}` }] };
  }

  const errors: ParseError[] = [];
  const root = "$";

  if (!checkType(raw, "object", root, errors)) {
    return { ok: false, errors };
  }

  const o = raw as Record<string, unknown>;

  // Required string fields
  for (const field of ["acb_version", "id", "generated_at"] as const) {
    const v = requireField(o, field, root, errors);
    if (v !== undefined) checkType(v, "string", `${root}.${field}`, errors);
  }

  // change_set_ref
  const csr = requireField(o, "change_set_ref", root, errors);
  if (csr !== undefined) {
    if (checkType(csr, "object", `${root}.change_set_ref`, errors)) {
      const csrObj = csr as Record<string, unknown>;
      const br = requireField(csrObj, "base_ref", `${root}.change_set_ref`, errors);
      if (br !== undefined) checkType(br, "string", `${root}.change_set_ref.base_ref`, errors);
      const hr = requireField(csrObj, "head_ref", `${root}.change_set_ref`, errors);
      if (hr !== undefined) checkType(hr, "string", `${root}.change_set_ref.head_ref`, errors);
      if ("repository" in csrObj && csrObj.repository !== undefined) {
        checkType(csrObj.repository, "string", `${root}.change_set_ref.repository`, errors);
      }
    }
  }

  // task_statement
  const ts = requireField(o, "task_statement", root, errors);
  if (ts !== undefined) {
    if (checkType(ts, "object", `${root}.task_statement`, errors)) {
      const tsObj = ts as Record<string, unknown>;
      const turns = requireField(tsObj, "turns", `${root}.task_statement`, errors);
      if (turns !== undefined) {
        if (checkType(turns, "array", `${root}.task_statement.turns`, errors)) {
          if (checkNonEmptyArray(turns, `${root}.task_statement.turns`, errors)) {
            (turns as unknown[]).forEach((t, i) =>
              validateTurn(t, `${root}.task_statement.turns[${i}]`, errors),
            );
          }
        }
      }
    }
  }

  // intent_groups
  const igs = requireField(o, "intent_groups", root, errors);
  if (igs !== undefined) {
    if (checkType(igs, "array", `${root}.intent_groups`, errors)) {
      if (checkNonEmptyArray(igs, `${root}.intent_groups`, errors)) {
        (igs as unknown[]).forEach((ig, i) =>
          validateIntentGroup(ig, `${root}.intent_groups[${i}]`, errors),
        );
      }
    }
  }

  // open_questions (optional)
  if ("open_questions" in o && o.open_questions !== undefined) {
    if (checkType(o.open_questions, "array", `${root}.open_questions`, errors)) {
      (o.open_questions as unknown[]).forEach((oq, i) =>
        validateOpenQuestion(oq, `${root}.open_questions[${i}]`, errors),
      );
    }
  }

  // negative_space (optional)
  if ("negative_space" in o && o.negative_space !== undefined) {
    if (checkType(o.negative_space, "array", `${root}.negative_space`, errors)) {
      (o.negative_space as unknown[]).forEach((ns, i) =>
        validateNegativeSpaceEntry(ns, `${root}.negative_space[${i}]`, errors),
      );
    }
  }

  // agent_id (optional string)
  if ("agent_id" in o && o.agent_id !== undefined) {
    checkType(o.agent_id, "string", `${root}.agent_id`, errors);
  }

  // extensions (optional object)
  if ("extensions" in o && o.extensions !== undefined) {
    checkType(o.extensions, "object", `${root}.extensions`, errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, data: o as unknown as AcbDocument };
}

/**
 * Parse a JSON string into a validated ReviewStateDocument.
 * Returns all structural errors collected, not just the first.
 */
export function parseReviewState(json: string): ParseResult<ReviewStateDocument> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, errors: [{ path: "$", message: `Invalid JSON: ${(e as Error).message}` }] };
  }

  const errors: ParseError[] = [];
  const root = "$";

  if (!checkType(raw, "object", root, errors)) {
    return { ok: false, errors };
  }

  const o = raw as Record<string, unknown>;

  // Required string fields
  for (const field of ["acb_version", "acb_hash", "acb_id", "reviewer", "updated_at"] as const) {
    const v = requireField(o, field, root, errors);
    if (v !== undefined) checkType(v, "string", `${root}.${field}`, errors);
  }

  // group_verdicts
  const gvs = requireField(o, "group_verdicts", root, errors);
  if (gvs !== undefined) {
    if (checkType(gvs, "array", `${root}.group_verdicts`, errors)) {
      (gvs as unknown[]).forEach((gv, i) =>
        validateGroupVerdict(gv, `${root}.group_verdicts[${i}]`, errors),
      );
    }
  }

  // question_answers (optional)
  if ("question_answers" in o && o.question_answers !== undefined) {
    if (checkType(o.question_answers, "array", `${root}.question_answers`, errors)) {
      (o.question_answers as unknown[]).forEach((qa, i) =>
        validateQuestionAnswer(qa, `${root}.question_answers[${i}]`, errors),
      );
    }
  }

  // overall_verdict
  const ov = requireField(o, "overall_verdict", root, errors);
  if (ov !== undefined) {
    if (checkType(ov, "string", `${root}.overall_verdict`, errors)) {
      checkEnum(ov, OVERALL_VERDICT_VALUES, `${root}.overall_verdict`, errors);
    }
  }

  // overall_comment (optional)
  if ("overall_comment" in o && o.overall_comment !== undefined) {
    checkType(o.overall_comment, "string", `${root}.overall_comment`, errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, data: o as unknown as ReviewStateDocument };
}

/**
 * Parse a JSON string into a validated IntentManifest.
 * Returns all structural errors collected, not just the first.
 */
export function parseIntentManifest(json: string): ParseResult<IntentManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, errors: [{ path: "$", message: `Invalid JSON: ${(e as Error).message}` }] };
  }

  const errors: ParseError[] = [];
  const root = "$";

  if (!checkType(raw, "object", root, errors)) {
    return { ok: false, errors };
  }

  const o = raw as Record<string, unknown>;

  // Required string fields
  for (const field of ["acb_manifest_version", "commit_sha", "timestamp"] as const) {
    const v = requireField(o, field, root, errors);
    if (v !== undefined) checkType(v, "string", `${root}.${field}`, errors);
  }

  // intent_groups (required, reuses existing validator)
  const igs = requireField(o, "intent_groups", root, errors);
  if (igs !== undefined) {
    if (checkType(igs, "array", `${root}.intent_groups`, errors)) {
      (igs as unknown[]).forEach((ig, i) =>
        validateIntentGroup(ig, `${root}.intent_groups[${i}]`, errors),
      );
    }
  }

  // negative_space (optional)
  if ("negative_space" in o && o.negative_space !== undefined) {
    if (checkType(o.negative_space, "array", `${root}.negative_space`, errors)) {
      (o.negative_space as unknown[]).forEach((ns, i) =>
        validateNegativeSpaceEntry(ns, `${root}.negative_space[${i}]`, errors),
      );
    }
  }

  // open_questions (optional)
  if ("open_questions" in o && o.open_questions !== undefined) {
    if (checkType(o.open_questions, "array", `${root}.open_questions`, errors)) {
      (o.open_questions as unknown[]).forEach((oq, i) =>
        validateOpenQuestion(oq, `${root}.open_questions[${i}]`, errors),
      );
    }
  }

  // agent_id (optional string)
  if ("agent_id" in o && o.agent_id !== undefined) {
    checkType(o.agent_id, "string", `${root}.agent_id`, errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, data: o as unknown as IntentManifest };
}
