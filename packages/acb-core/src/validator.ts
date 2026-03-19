/**
 * Validation rules for ACB and Review State documents.
 * Implements Section 7 of the ACB spec (ACB-1 through ACB-13, REV-1 through REV-6).
 */

import type {
  AcbDocument,
  ReviewStateDocument,
  ValidationResult,
  IntentGroup,
  FileRef,
  Annotation,
} from "./types.js";

import {
  AMBIGUITY_TAGS,
  GROUP_VERDICT_VALUES,
  OVERALL_VERDICT_VALUES,
} from "./types.js";

// --- Helper Types ---

export interface ChangedFile {
  path: string;
  ranges: string[];
}

// --- Helpers ---

const RANGE_RE = /^[1-9][0-9]*(-[1-9][0-9]*)?$/;

function pass(rule: string): ValidationResult {
  return { rule, valid: true };
}

function fail(rule: string, message: string, path?: string): ValidationResult {
  return { rule, valid: false, message, path };
}

/** Collect all intent group ids. */
function groupIds(doc: AcbDocument): Set<string> {
  return new Set(doc.intent_groups.map((g) => g.id));
}

/** Collect all annotations across all intent groups. */
function allAnnotations(doc: AcbDocument): Annotation[] {
  return doc.intent_groups.flatMap((g) => g.annotations ?? []);
}

/** Parse a range string into [start, end] (both inclusive, 1-based). */
function parseRange(r: string): [number, number] | null {
  if (!RANGE_RE.test(r)) return null;
  const parts = r.split("-");
  const start = parseInt(parts[0], 10);
  const end = parts.length === 2 ? parseInt(parts[1], 10) : start;
  return [start, end];
}

// --- ACB Document Rules ---

/**
 * ACB-1: Complete coverage.
 * Every changed line must appear in at least one intent group's file_refs ranges.
 * Requires diff information to validate.
 */
export function validateAcb1(
  doc: AcbDocument,
  changedFiles?: ChangedFile[],
): ValidationResult[] {
  if (!changedFiles) {
    return [
      {
        rule: "ACB-1",
        valid: true,
        message:
          "Skipped — no diff information provided for complete coverage check",
      },
    ];
  }

  const results: ValidationResult[] = [];

  // Build a map of path -> Set<line number> from intent groups
  const coveredLines = new Map<string, Set<number>>();
  for (const group of doc.intent_groups) {
    for (const ref of group.file_refs) {
      if (!coveredLines.has(ref.path)) {
        coveredLines.set(ref.path, new Set());
      }
      const set = coveredLines.get(ref.path)!;
      for (const r of ref.ranges) {
        const parsed = parseRange(r);
        if (parsed) {
          for (let line = parsed[0]; line <= parsed[1]; line++) {
            set.add(line);
          }
        }
      }
    }
  }

  for (const file of changedFiles) {
    const covered = coveredLines.get(file.path) ?? new Set<number>();
    for (const r of file.ranges) {
      const parsed = parseRange(r);
      if (!parsed) continue;
      for (let line = parsed[0]; line <= parsed[1]; line++) {
        if (!covered.has(line)) {
          results.push(
            fail(
              "ACB-1",
              `Changed line ${line} in "${file.path}" is not covered by any intent group`,
              file.path,
            ),
          );
          // Only report one uncovered line per file to avoid noise
          break;
        }
      }
      // Break out of outer loop too if we already reported for this file
      if (results.length > 0 && results[results.length - 1].path === file.path)
        break;
    }
  }

  if (results.length === 0) {
    results.push(pass("ACB-1"));
  }

  return results;
}

/**
 * ACB-2: Explicit grounding.
 * Every intent group with classification "explicit" must have task_grounding
 * that references a turn_id or quotes the task.
 */
export function validateAcb2(doc: AcbDocument): ValidationResult[] {
  const results: ValidationResult[] = [];
  const turnIds = new Set(doc.task_statement.turns.map((t) => t.turn_id));

  for (const group of doc.intent_groups) {
    if (group.classification !== "explicit") continue;

    if (!group.task_grounding || group.task_grounding.trim() === "") {
      results.push(
        fail(
          "ACB-2",
          `Intent group "${group.id}" has classification "explicit" but empty task_grounding`,
          `intent_groups[${group.id}].task_grounding`,
        ),
      );
      continue;
    }

    // Check if grounding references any turn_id
    const referencesATurn = Array.from(turnIds).some((tid) =>
      group.task_grounding.includes(tid),
    );
    // If it doesn't reference a turn_id, we accept it if it's non-empty
    // (it might quote the relevant passage instead — we can't fully verify quoting)
    if (!referencesATurn && turnIds.size > 0) {
      // Structural check only: grounding exists but doesn't reference a turn_id.
      // This is acceptable if it quotes the passage instead.
    }
  }

  if (results.length === 0) {
    results.push(pass("ACB-2"));
  }
  return results;
}

/**
 * ACB-3: Non-empty grounding.
 * Every intent group with classification "inferred" or "speculative" must
 * have non-empty task_grounding.
 */
export function validateAcb3(doc: AcbDocument): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const group of doc.intent_groups) {
    if (group.classification !== "inferred" && group.classification !== "speculative") continue;

    if (!group.task_grounding || group.task_grounding.trim() === "") {
      results.push(
        fail(
          "ACB-3",
          `Intent group "${group.id}" has classification "${group.classification}" but empty task_grounding`,
          `intent_groups[${group.id}].task_grounding`,
        ),
      );
    }
  }

  if (results.length === 0) {
    results.push(pass("ACB-3"));
  }
  return results;
}

/**
 * ACB-4: Judgment call tags.
 * Every annotation with type "judgment_call" must have a non-empty ambiguity_tags
 * array containing only values from Section 5.4.
 */
export function validateAcb4(doc: AcbDocument): ValidationResult[] {
  const results: ValidationResult[] = [];
  const validTags = new Set<string>(AMBIGUITY_TAGS);

  for (const group of doc.intent_groups) {
    for (const ann of group.annotations ?? []) {
      if (ann.type !== "judgment_call") continue;

      if (!ann.ambiguity_tags || ann.ambiguity_tags.length === 0) {
        results.push(
          fail(
            "ACB-4",
            `Annotation "${ann.id}" has type "judgment_call" but no ambiguity_tags`,
            `annotations[${ann.id}].ambiguity_tags`,
          ),
        );
        continue;
      }

      for (const tag of ann.ambiguity_tags) {
        if (!validTags.has(tag)) {
          results.push(
            fail(
              "ACB-4",
              `Annotation "${ann.id}" has invalid ambiguity tag "${tag}"`,
              `annotations[${ann.id}].ambiguity_tags`,
            ),
          );
        }
      }
    }
  }

  if (results.length === 0) {
    results.push(pass("ACB-4"));
  }
  return results;
}

/**
 * ACB-5: Causal link targets exist.
 * Every target_group_id in a causal link must reference an existing intent group id.
 */
export function validateAcb5(doc: AcbDocument): ValidationResult[] {
  const results: ValidationResult[] = [];
  const ids = groupIds(doc);

  for (const group of doc.intent_groups) {
    // Group-level causal links
    for (const link of group.causal_links ?? []) {
      if (!ids.has(link.target_group_id)) {
        results.push(
          fail(
            "ACB-5",
            `Causal link in group "${group.id}" references non-existent group "${link.target_group_id}"`,
            `intent_groups[${group.id}].causal_links`,
          ),
        );
      }
    }
    // Annotation-level causal links
    for (const ann of group.annotations ?? []) {
      for (const link of ann.causal_links ?? []) {
        if (!ids.has(link.target_group_id)) {
          results.push(
            fail(
              "ACB-5",
              `Causal link in annotation "${ann.id}" references non-existent group "${link.target_group_id}"`,
              `annotations[${ann.id}].causal_links`,
            ),
          );
        }
      }
    }
  }

  if (results.length === 0) {
    results.push(pass("ACB-5"));
  }
  return results;
}

/**
 * ACB-6: Unique identifiers.
 * All ids across intent groups, annotations, and open questions must be unique.
 */
export function validateAcb6(doc: AcbDocument): ValidationResult[] {
  const results: ValidationResult[] = [];
  const seen = new Map<string, string>();

  function checkId(id: string, location: string) {
    if (seen.has(id)) {
      results.push(
        fail(
          "ACB-6",
          `Duplicate id "${id}" found in ${location} (first seen in ${seen.get(id)})`,
          location,
        ),
      );
    } else {
      seen.set(id, location);
    }
  }

  for (const group of doc.intent_groups) {
    checkId(group.id, `intent_groups[${group.id}]`);
    for (const ann of group.annotations ?? []) {
      checkId(ann.id, `annotations[${ann.id}]`);
    }
  }

  for (const q of doc.open_questions ?? []) {
    checkId(q.id, `open_questions[${q.id}]`);
  }

  if (results.length === 0) {
    results.push(pass("ACB-6"));
  }
  return results;
}

/**
 * ACB-7: Verbatim task.
 * task_statement must have non-empty turns with non-empty content.
 * (Structural check only — can't verify "verbatim" programmatically.)
 */
export function validateAcb7(doc: AcbDocument): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (!doc.task_statement.turns || doc.task_statement.turns.length === 0) {
    results.push(
      fail(
        "ACB-7",
        "task_statement has no turns",
        "task_statement.turns",
      ),
    );
    return results;
  }

  for (let i = 0; i < doc.task_statement.turns.length; i++) {
    const turn = doc.task_statement.turns[i];
    if (!turn.content || turn.content.trim() === "") {
      results.push(
        fail(
          "ACB-7",
          `Turn ${i} (${turn.turn_id}) has empty content`,
          `task_statement.turns[${i}].content`,
        ),
      );
    }
  }

  if (results.length === 0) {
    results.push(pass("ACB-7"));
  }
  return results;
}

/**
 * ACB-8: Acyclic causal graph.
 * The directed graph formed by all causal links must be a DAG.
 * Uses DFS-based cycle detection.
 */
export function validateAcb8(doc: AcbDocument): ValidationResult[] {
  // Build adjacency list from all causal links
  const adj = new Map<string, string[]>();
  const ids = groupIds(doc);

  for (const id of ids) {
    adj.set(id, []);
  }

  for (const group of doc.intent_groups) {
    for (const link of group.causal_links ?? []) {
      if (ids.has(link.target_group_id)) {
        adj.get(group.id)!.push(link.target_group_id);
      }
    }
    for (const ann of group.annotations ?? []) {
      for (const link of ann.causal_links ?? []) {
        if (ids.has(link.target_group_id)) {
          adj.get(group.id)!.push(link.target_group_id);
        }
      }
    }
  }

  // DFS cycle detection
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const id of ids) color.set(id, WHITE);

  let cycleFound = false;
  const cyclePath: string[] = [];

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    for (const neighbor of adj.get(node) ?? []) {
      if (color.get(neighbor) === GRAY) {
        cyclePath.push(node, neighbor);
        return true;
      }
      if (color.get(neighbor) === WHITE && dfs(neighbor)) {
        return true;
      }
    }
    color.set(node, BLACK);
    return false;
  }

  for (const id of ids) {
    if (color.get(id) === WHITE) {
      if (dfs(id)) {
        cycleFound = true;
        break;
      }
    }
  }

  if (cycleFound) {
    return [
      fail(
        "ACB-8",
        `Causal link graph contains a cycle involving: ${cyclePath.join(" → ")}`,
        "causal_links",
      ),
    ];
  }

  return [pass("ACB-8")];
}

/**
 * ACB-9: Scope creep tag constraint.
 * "scope_creep" ambiguity tag on intent groups is only allowed when
 * classification is "speculative".
 */
export function validateAcb9(doc: AcbDocument): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const group of doc.intent_groups) {
    if (
      group.ambiguity_tags.includes("scope_creep") &&
      group.classification !== "speculative"
    ) {
      results.push(
        fail(
          "ACB-9",
          `Intent group "${group.id}" has "scope_creep" tag but classification is "${group.classification}" (must be "speculative")`,
          `intent_groups[${group.id}].ambiguity_tags`,
        ),
      );
    }
  }

  if (results.length === 0) {
    results.push(pass("ACB-9"));
  }
  return results;
}

/**
 * ACB-10: Open question references exist.
 * Every related_group_ids value must reference an existing intent group.
 */
export function validateAcb10(doc: AcbDocument): ValidationResult[] {
  const results: ValidationResult[] = [];
  const ids = groupIds(doc);

  for (const q of doc.open_questions ?? []) {
    for (const gid of q.related_group_ids ?? []) {
      if (!ids.has(gid)) {
        results.push(
          fail(
            "ACB-10",
            `Open question "${q.id}" references non-existent group "${gid}"`,
            `open_questions[${q.id}].related_group_ids`,
          ),
        );
      }
    }
  }

  if (results.length === 0) {
    results.push(pass("ACB-10"));
  }
  return results;
}

/**
 * ACB-11: Non-empty intent groups.
 * intent_groups array must have at least one element.
 */
export function validateAcb11(doc: AcbDocument): ValidationResult[] {
  if (doc.intent_groups.length === 0) {
    return [fail("ACB-11", "intent_groups array is empty", "intent_groups")];
  }
  return [pass("ACB-11")];
}

/**
 * ACB-12: Non-empty file refs.
 * Every intent group's file_refs must have at least one element.
 */
export function validateAcb12(doc: AcbDocument): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const group of doc.intent_groups) {
    if (!group.file_refs || group.file_refs.length === 0) {
      results.push(
        fail(
          "ACB-12",
          `Intent group "${group.id}" has no file_refs`,
          `intent_groups[${group.id}].file_refs`,
        ),
      );
    }
  }

  if (results.length === 0) {
    results.push(pass("ACB-12"));
  }
  return results;
}

/**
 * ACB-13: Valid range format.
 * Every range string must match ^[1-9][0-9]*(-[1-9][0-9]*)?$ and for N-M, N <= M.
 */
export function validateAcb13(doc: AcbDocument): ValidationResult[] {
  const results: ValidationResult[] = [];

  function checkRanges(refs: FileRef[], context: string) {
    for (const ref of refs) {
      for (const r of ref.ranges) {
        if (!RANGE_RE.test(r)) {
          results.push(
            fail(
              "ACB-13",
              `Invalid range format "${r}" in ${context}`,
              `${context}.ranges`,
            ),
          );
          continue;
        }
        const parts = r.split("-");
        if (parts.length === 2) {
          const n = parseInt(parts[0], 10);
          const m = parseInt(parts[1], 10);
          if (n > m) {
            results.push(
              fail(
                "ACB-13",
                `Range "${r}" has start > end in ${context}`,
                `${context}.ranges`,
              ),
            );
          }
        }
      }
    }
  }

  for (const group of doc.intent_groups) {
    checkRanges(group.file_refs, `intent_groups[${group.id}]`);
    for (const ann of group.annotations ?? []) {
      checkRanges(ann.file_refs ?? [], `annotations[${ann.id}]`);
    }
  }

  if (results.length === 0) {
    results.push(pass("ACB-13"));
  }
  return results;
}

// --- Review State Document Rules ---

/**
 * REV-1: Valid hash format.
 * acb_hash must be a 64-character lowercase hex string.
 */
export function validateRev1(review: ReviewStateDocument): ValidationResult[] {
  const hashRe = /^[0-9a-f]{64}$/;
  if (!hashRe.test(review.acb_hash)) {
    return [
      fail(
        "REV-1",
        `acb_hash "${review.acb_hash}" is not a valid 64-char lowercase hex string`,
        "acb_hash",
      ),
    ];
  }
  return [pass("REV-1")];
}

/**
 * REV-2: Complete group coverage.
 * group_verdicts must have exactly one entry per intent group, no extras.
 */
export function validateRev2(
  review: ReviewStateDocument,
  acb: AcbDocument,
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const expectedIds = groupIds(acb);
  const verdictIds = new Set(review.group_verdicts.map((v) => v.group_id));

  for (const id of expectedIds) {
    if (!verdictIds.has(id)) {
      results.push(
        fail(
          "REV-2",
          `Missing group verdict for intent group "${id}"`,
          `group_verdicts`,
        ),
      );
    }
  }

  for (const id of verdictIds) {
    if (!expectedIds.has(id)) {
      results.push(
        fail(
          "REV-2",
          `Extra group verdict for unknown intent group "${id}"`,
          `group_verdicts`,
        ),
      );
    }
  }

  if (results.length === 0) {
    results.push(pass("REV-2"));
  }
  return results;
}

/**
 * REV-3: Valid verdict values.
 * All verdicts must be valid enum values.
 */
export function validateRev3(review: ReviewStateDocument): ValidationResult[] {
  const results: ValidationResult[] = [];
  const validGroupVerdicts = new Set<string>(GROUP_VERDICT_VALUES);
  const validOverallVerdicts = new Set<string>(OVERALL_VERDICT_VALUES);

  for (const gv of review.group_verdicts) {
    if (!validGroupVerdicts.has(gv.verdict)) {
      results.push(
        fail(
          "REV-3",
          `Invalid verdict "${gv.verdict}" for group "${gv.group_id}"`,
          `group_verdicts[${gv.group_id}].verdict`,
        ),
      );
    }
  }

  if (!validOverallVerdicts.has(review.overall_verdict)) {
    results.push(
      fail(
        "REV-3",
        `Invalid overall_verdict "${review.overall_verdict}"`,
        "overall_verdict",
      ),
    );
  }

  if (results.length === 0) {
    results.push(pass("REV-3"));
  }
  return results;
}

/**
 * REV-4: Annotation response targets exist.
 * Every annotation_id in an annotation response must correspond to an annotation in the ACB.
 */
export function validateRev4(
  review: ReviewStateDocument,
  acb: AcbDocument,
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const annotationIds = new Set(allAnnotations(acb).map((a) => a.id));

  for (const gv of review.group_verdicts) {
    for (const ar of gv.annotation_responses ?? []) {
      if (!annotationIds.has(ar.annotation_id)) {
        results.push(
          fail(
            "REV-4",
            `Annotation response references non-existent annotation "${ar.annotation_id}"`,
            `group_verdicts[${gv.group_id}].annotation_responses`,
          ),
        );
      }
    }
  }

  if (results.length === 0) {
    results.push(pass("REV-4"));
  }
  return results;
}

/**
 * REV-5: Question answer targets exist.
 * Every question_id in a question answer must correspond to an open question in the ACB.
 */
export function validateRev5(
  review: ReviewStateDocument,
  acb: AcbDocument,
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const questionIds = new Set((acb.open_questions ?? []).map((q) => q.id));

  for (const qa of review.question_answers ?? []) {
    if (!questionIds.has(qa.question_id)) {
      results.push(
        fail(
          "REV-5",
          `Question answer references non-existent question "${qa.question_id}"`,
          `question_answers`,
        ),
      );
    }
  }

  if (results.length === 0) {
    results.push(pass("REV-5"));
  }
  return results;
}

/**
 * REV-6: Non-empty reviewer.
 * reviewer must be a non-empty string.
 */
export function validateRev6(review: ReviewStateDocument): ValidationResult[] {
  if (!review.reviewer || review.reviewer.trim() === "") {
    return [fail("REV-6", "reviewer field is empty", "reviewer")];
  }
  return [pass("REV-6")];
}

// --- Aggregate Validators ---

/**
 * Validate an ACB document with rules ACB-2 through ACB-13 (skips ACB-1 which needs diff data).
 */
export function validateAcbDocument(doc: AcbDocument): ValidationResult[] {
  return [
    ...validateAcb2(doc),
    ...validateAcb3(doc),
    ...validateAcb4(doc),
    ...validateAcb5(doc),
    ...validateAcb6(doc),
    ...validateAcb7(doc),
    ...validateAcb8(doc),
    ...validateAcb9(doc),
    ...validateAcb10(doc),
    ...validateAcb11(doc),
    ...validateAcb12(doc),
    ...validateAcb13(doc),
  ];
}

/**
 * Validate an ACB document with ALL rules including ACB-1 (requires diff data).
 */
export function validateAcbDocumentWithDiff(
  doc: AcbDocument,
  changedFiles: ChangedFile[],
): ValidationResult[] {
  return [...validateAcb1(doc, changedFiles), ...validateAcbDocument(doc)];
}

/**
 * Validate a Review State document against its referenced ACB document.
 */
export function validateReviewState(
  review: ReviewStateDocument,
  acb: AcbDocument,
): ValidationResult[] {
  return [
    ...validateRev1(review),
    ...validateRev2(review, acb),
    ...validateRev3(review),
    ...validateRev4(review, acb),
    ...validateRev5(review, acb),
    ...validateRev6(review),
  ];
}
