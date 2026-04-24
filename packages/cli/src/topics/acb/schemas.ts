/**
 * ACB v2 schemas — validation for intent manifests and review state documents.
 *
 * Ported 1:1 from `tools/acb/schemas.py`. Constants, field names, and error
 * strings match the Python source byte-for-byte — on-disk artifacts must stay
 * readable across the Python -> TS cutover, and commit-hook consumers parse
 * the error list directly.
 *
 * Each validator returns a flat `string[]` of error messages (empty = valid).
 * Errors accumulate; validators never short-circuit past the structural head.
 */

// ---------------------------------------------------------------------------
// Version constants
// ---------------------------------------------------------------------------

export const CURRENT_MANIFEST_VERSION = '0.2';
export const CURRENT_ACB_VERSION = '0.2';

// ---------------------------------------------------------------------------
// Enum tuples — mirror tools/acb/schemas.py exactly
// ---------------------------------------------------------------------------

export const CLASSIFICATIONS = ['explicit', 'inferred', 'speculative'] as const;

export const AMBIGUITY_TAGS = [
  'underspecified',
  'conflicting_signals',
  'assumption',
  'scope_creep',
  'convention',
] as const;

export const ANNOTATION_TYPES = ['judgment_call', 'note', 'flag'] as const;

export const NEGATIVE_SPACE_REASONS = [
  'out_of_scope',
  'possible_other_callers',
  'intentionally_preserved',
  'would_require_escalation',
] as const;

/**
 * Canonical verdict vocabulary. Used both by the on-disk manifest schema
 * (Python-compatible, mirrors `tools/acb/schemas.py`) AND by the review-UI's
 * live `acb_group_verdicts` DB table via `GroupVerdict` in `./store.ts`.
 *
 * `'rework'` is an extension beyond the Python manifest schema — it
 * represents a review-UI-only state where the group is rejected with a
 * generated fix brief. The Python manifest validator tolerates it because
 * `isVerdictValue` here is the single source of truth.
 *
 * Legacy values written by earlier TS builds (`'approved'`, `'discuss'`)
 * are coerced to canonical at the DB read boundary via
 * `coerceLegacyVerdict` in `./store.ts`; do not add them back here.
 */
export const VERDICT_VALUES = [
  'accepted',
  'rejected',
  'needs_discussion',
  'pending',
  'rework',
] as const;

export const OVERALL_VERDICTS = ['approved', 'changes_requested', 'pending'] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];
export type AmbiguityTag = (typeof AMBIGUITY_TAGS)[number];
export type AnnotationType = (typeof ANNOTATION_TYPES)[number];
export type NegativeSpaceReason = (typeof NEGATIVE_SPACE_REASONS)[number];
export type VerdictValue = (typeof VERDICT_VALUES)[number];
export type OverallVerdict = (typeof OVERALL_VERDICTS)[number];

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const MANIFEST_REQUIRED_FIELDS = [
  'acb_manifest_version',
  'commit_sha',
  'timestamp',
  'intent_groups',
] as const;

const GROUP_REQUIRED_FIELDS = ['id', 'title', 'classification', 'file_refs'] as const;

const REVIEW_REQUIRED_FIELDS = [
  'acb_version',
  'acb_hash',
  'acb_id',
  'group_verdicts',
  'overall_verdict',
] as const;

/**
 * Validate an intent manifest. Returns error strings (empty list = valid).
 * Error strings match `tools/acb/schemas.py::validate_manifest` byte-for-byte.
 */
export function validateManifest(data: unknown): string[] {
  if (!isPlainObject(data)) {
    return ['Manifest must be a JSON object'];
  }

  const errors: string[] = [];
  for (const field of MANIFEST_REQUIRED_FIELDS) {
    if (!(field in data)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  const groups = data.intent_groups;
  if (groups !== undefined && groups !== null) {
    errors.push(...validateIntentGroups(groups));
  }

  return errors;
}

function validateIntentGroups(groups: unknown): string[] {
  if (!Array.isArray(groups)) {
    return ['intent_groups must be an array'];
  }
  if (groups.length === 0) {
    return ['intent_groups must not be empty'];
  }

  const errors: string[] = [];
  const seenIds = new Set<unknown>();
  for (let i = 0; i < groups.length; i++) {
    const pfx = `intent_groups[${i}]`;
    const group = groups[i];
    if (!isPlainObject(group)) {
      errors.push(`${pfx}: must be an object`);
      continue;
    }

    for (const f of GROUP_REQUIRED_FIELDS) {
      if (!(f in group)) {
        errors.push(`${pfx}: missing required field '${f}'`);
      }
    }

    const gid = group.id;
    if (gid !== undefined && gid !== null) {
      if (seenIds.has(gid)) {
        errors.push(`${pfx}: duplicate id '${String(gid)}'`);
      }
      seenIds.add(gid);
    }

    const cls = group.classification;
    if (cls !== undefined && cls !== null && !isClassification(cls)) {
      errors.push(`${pfx}: invalid classification '${String(cls)}'`);
    }

    const refs = group.file_refs;
    if (refs !== undefined && refs !== null && (!Array.isArray(refs) || refs.length === 0)) {
      errors.push(`${pfx}: file_refs must be a non-empty array`);
    }
  }

  return errors;
}

/**
 * Validate a review state document. Returns error strings (empty list = valid).
 * Error strings match `tools/acb/schemas.py::validate_review_state` byte-for-byte.
 */
export function validateReviewState(data: unknown): string[] {
  if (!isPlainObject(data)) {
    return ['Review state must be a JSON object'];
  }

  const errors: string[] = [];
  for (const field of REVIEW_REQUIRED_FIELDS) {
    if (!(field in data)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  const verdicts = data.group_verdicts;
  if (verdicts !== undefined && verdicts !== null) {
    errors.push(...validateGroupVerdicts(verdicts));
  }

  const ov = data.overall_verdict;
  if (ov !== undefined && ov !== null && !isOverallVerdict(ov)) {
    errors.push(`Invalid overall_verdict: '${String(ov)}'`);
  }

  return errors;
}

function validateGroupVerdicts(verdicts: unknown): string[] {
  if (!Array.isArray(verdicts)) {
    return ['group_verdicts must be an array'];
  }

  const errors: string[] = [];
  for (let i = 0; i < verdicts.length; i++) {
    const pfx = `group_verdicts[${i}]`;
    const v = verdicts[i];
    if (!isPlainObject(v)) {
      errors.push(`${pfx}: must be an object`);
      continue;
    }
    if (!('group_id' in v)) {
      errors.push(`${pfx}: missing group_id`);
    }
    const vrd = v.verdict;
    if (vrd === undefined || vrd === null) {
      errors.push(`${pfx}: missing verdict`);
    } else if (!isVerdictValue(vrd)) {
      errors.push(`${pfx}: invalid verdict '${String(vrd)}'`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClassification(value: unknown): value is Classification {
  return typeof value === 'string' && (CLASSIFICATIONS as readonly string[]).includes(value);
}

function isVerdictValue(value: unknown): value is VerdictValue {
  return typeof value === 'string' && (VERDICT_VALUES as readonly string[]).includes(value);
}

function isOverallVerdict(value: unknown): value is OverallVerdict {
  return typeof value === 'string' && (OVERALL_VERDICTS as readonly string[]).includes(value);
}
