/**
 * Reasoning Log — typed, append-only reasoning capture for a run.
 *
 * Ports the 10 typed log entries + episode derivation from onleash's
 * reasoning journal (see `docs/onleash-port-audit.md` §5.1). This module is
 * the DATA + INGEST foundation: the entry union, a strict validator, and the
 * filesystem read/merge + episode-derivation primitives the `acb log`
 * subcommand exposes.
 *
 * On-disk layout (one JSON file per entry, written by the native Write tool —
 * NOT through long prose flags, which would force Bash-quoting of multi-line
 * rationale):
 *
 *   <run-dir>/log/<agent>/<entry-id>.json
 *
 * `acb log list` merges every per-entry file under `<run-dir>/log/` and sorts
 * by `ts`; `acb log episodes` derives episodes from `decision` boundaries.
 *
 * Validation is STRICT and closed: unknown `type` values and unknown fields
 * (top-level or per-type) are rejected. The closed union is the contract the
 * brief synthesizer (a later task) reads — see the TODO seam in this module.
 */

// ---------------------------------------------------------------------------
// Closed type union — mirrors audit §5.1
// ---------------------------------------------------------------------------

/**
 * The 10 closed entry types. `decision`..`synthesis` are agent-authored
 * (`context` records context the agent proactively loaded before acting);
 * `review_feedback` and `verification` are engine-written (validators /
 * principal-architect / verification dispatch). Extending this set is
 * extension-gated — add the literal here AND the per-type field spec below.
 */
export const ENTRY_TYPES = [
  'decision',
  'discovery',
  'context',
  'bailout',
  'hack',
  'risk',
  'assumption',
  'synthesis',
  'review_feedback',
  'verification',
] as const;

export type EntryType = (typeof ENTRY_TYPES)[number];

export const RISK_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

/**
 * Common envelope shared by every entry. Per-type fields extend this; the
 * validator checks the envelope first, then the type-specific spec.
 */
export interface EntryEnvelope {
  /** Stable UUID; the entry filename stem. */
  id: string;
  /** ISO-8601 timestamp; the sort key for `list` and episode derivation. */
  ts: string;
  type: EntryType;
  /** Authoring agent (also the `log/<agent>/` dir segment). */
  agent: string;
  /** Run directory this entry belongs to. */
  run_path: string;
  /** Free-form prose body — the attention-bearing content. */
  body: string;
}

export interface DecisionEntry extends EntryEnvelope {
  type: 'decision';
  /** Options weighed before selecting. */
  alternatives: string[];
  /** Why the selected option won. */
  selected_rationale: string;
}

export interface DiscoveryEntry extends EntryEnvelope {
  type: 'discovery';
}

export interface ContextEntry extends EntryEnvelope {
  type: 'context';
}

export interface BailoutEntry extends EntryEnvelope {
  type: 'bailout';
  /** What was attempted before abandoning. */
  attempted: string;
  /** Why the approach was abandoned. */
  reason_abandoned: string;
}

export interface HackEntry extends EntryEnvelope {
  type: 'hack';
  /** Files the hack touches. */
  file_refs: string[];
  /** The condition under which the hack must be cleaned up. */
  cleanup_condition: string;
}

export interface RiskEntry extends EntryEnvelope {
  type: 'risk';
  severity: RiskSeverity;
  mitigation: string;
}

export interface AssumptionEntry extends EntryEnvelope {
  type: 'assumption';
  /** Has the assumption been confirmed/resolved? */
  resolved: boolean;
  /** Pointer (entry id, doc ref, etc.) to where it was resolved; null if open. */
  resolution_ref: string | null;
}

export interface SynthesisEntry extends EntryEnvelope {
  type: 'synthesis';
  /** The synthesized outcome of the preceding episode. */
  outcome: string;
}

export interface ReviewFeedbackEntry extends EntryEnvelope {
  type: 'review_feedback';
}

export interface VerificationEntry extends EntryEnvelope {
  type: 'verification';
}

/** The closed union of every reasoning-log entry. */
export type LogEntry =
  | DecisionEntry
  | DiscoveryEntry
  | ContextEntry
  | BailoutEntry
  | HackEntry
  | RiskEntry
  | AssumptionEntry
  | SynthesisEntry
  | ReviewFeedbackEntry
  | VerificationEntry;

// ---------------------------------------------------------------------------
// Field specification — drives strict validation
// ---------------------------------------------------------------------------

/** Envelope keys present on every entry regardless of type. */
const ENVELOPE_FIELDS = ['id', 'ts', 'type', 'agent', 'run_path', 'body'] as const;

interface FieldSpec {
  /** Required type-specific fields and how to validate each value. */
  fields: Record<string, (value: unknown) => boolean>;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArray = (v: unknown): boolean => Array.isArray(v) && v.every(isStr);
const isBool = (v: unknown): boolean => typeof v === 'boolean';
const isStrOrNull = (v: unknown): boolean => v === null || isStr(v);
const isRiskSeverity = (v: unknown): boolean =>
  isStr(v) && (RISK_SEVERITIES as readonly string[]).includes(v);

/**
 * Per-type required fields beyond the envelope. A type with no extra fields
 * (discovery, context, review_feedback, verification) maps to an empty spec —
 * the envelope alone is its full shape.
 */
const TYPE_SPECS: Record<EntryType, FieldSpec> = {
  decision: { fields: { alternatives: isStrArray, selected_rationale: isStr } },
  discovery: { fields: {} },
  context: { fields: {} },
  bailout: { fields: { attempted: isStr, reason_abandoned: isStr } },
  hack: { fields: { file_refs: isStrArray, cleanup_condition: isStr } },
  risk: { fields: { severity: isRiskSeverity, mitigation: isStr } },
  assumption: { fields: { resolved: isBool, resolution_ref: isStrOrNull } },
  synthesis: { fields: { outcome: isStr } },
  review_feedback: { fields: {} },
  verification: { fields: {} },
};

// ---------------------------------------------------------------------------
// Strict validation
// ---------------------------------------------------------------------------

/**
 * Validate a parsed JSON value against the closed entry union. Returns a flat
 * `string[]` of error messages (empty = valid), matching the accumulating
 * style of `./schemas.ts`. STRICT: unknown top-level keys and unknown
 * per-type keys are rejected, not ignored.
 */
export function validateLogEntry(data: unknown): string[] {
  if (!isPlainObject(data)) {
    return ['Log entry must be a JSON object'];
  }

  const errors: string[] = [];

  for (const field of ENVELOPE_FIELDS) {
    if (!(field in data)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  const type = data.type;
  if (!isEntryType(type)) {
    errors.push(`Invalid type '${String(type)}' (expected one of: ${ENTRY_TYPES.join(', ')})`);
    // Without a known type we can't check per-type fields; return the
    // envelope + type errors gathered so far.
    return errors;
  }

  for (const field of ENVELOPE_FIELDS) {
    if (field === 'type') continue;
    const value = data[field];
    if (value !== undefined && !isStr(value)) {
      errors.push(`Field '${field}' must be a string`);
    }
  }

  const spec = TYPE_SPECS[type];
  const allowedKeys = new Set<string>([...ENVELOPE_FIELDS, ...Object.keys(spec.fields)]);

  for (const [field, check] of Object.entries(spec.fields)) {
    if (!(field in data)) {
      errors.push(`Missing required field for type '${type}': ${field}`);
      continue;
    }
    if (!check(data[field])) {
      errors.push(`Invalid value for '${field}' on type '${type}'`);
    }
  }

  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      errors.push(`Unknown field '${key}' for type '${type}'`);
    }
  }

  return errors;
}

/** Parse + validate; throws on the first failure with the joined error list. */
export function parseLogEntry(data: unknown): LogEntry {
  const errors = validateLogEntry(data);
  if (errors.length > 0) {
    throw new Error(`invalid log entry: ${errors.join('; ')}`);
  }
  return data as LogEntry;
}

// ---------------------------------------------------------------------------
// Episode derivation
// ---------------------------------------------------------------------------

/**
 * An episode opens on a `decision` entry and closes at the next `decision` or
 * `synthesis`. Every non-`decision` entry attaches to the currently-open
 * episode; entries before the first `decision` belong to no episode and are
 * dropped from episode output. Zero decisions => zero episodes.
 */
export interface Episode {
  /** The opening `decision` entry. */
  decision: DecisionEntry;
  /** Entries attached to this episode, in `ts` order (excludes the opener). */
  entries: LogEntry[];
  /** The `decision`/`synthesis` entry that closed it, or null if still open. */
  closed_by: LogEntry | null;
}

/**
 * Derive episodes from a `ts`-sorted entry list. Pure: no IO. The synthesizer
 * (later task) consumes this alongside `listEntries`.
 *
 * TODO(reasoning-brief): the brief synthesizer skill consumes `listEntries`
 * + `deriveEpisodes` to produce the 7-section risk-forward Brief (audit §5.1)
 * via multipass episode-chunk -> fragment -> merge. Not built here.
 */
export function deriveEpisodes(entries: LogEntry[]): Episode[] {
  const episodes: Episode[] = [];
  let open: Episode | null = null;

  for (const entry of entries) {
    if (entry.type === 'decision') {
      if (open) open.closed_by = entry;
      open = { decision: entry, entries: [], closed_by: null };
      episodes.push(open);
      continue;
    }
    if (entry.type === 'synthesis') {
      if (open) {
        open.entries.push(entry);
        open.closed_by = entry;
        open = null;
      }
      continue;
    }
    if (open) open.entries.push(entry);
  }

  return episodes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEntryType(value: unknown): value is EntryType {
  return typeof value === 'string' && (ENTRY_TYPES as readonly string[]).includes(value);
}
