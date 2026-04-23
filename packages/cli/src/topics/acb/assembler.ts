/**
 * Assemble per-commit intent manifests into a cumulative ACB review document.
 *
 * Ported 1:1 from `tools/acb/assembler.py`. Merge rules, dedup keys, and JSON
 * hashing are byte-compatible with the Python reference so manifests written
 * by either implementation yield identical ACB documents — parity is pinned
 * via `__fixtures__/assembler/python-captures/`.
 *
 * Design notes:
 *   - `computeAcbHash` must produce the exact bytes of Python's
 *     `json.dumps(..., sort_keys=True, separators=(",", ":"))`. The sorted-
 *     keys serializer below walks the value tree, stringifying primitives
 *     the JSON way, preserving array order, and emitting object keys in
 *     lexicographic order.
 *   - `loadManifestsFromStore` logs (warn) invalid manifests and skips
 *     them. Matches Python's `logger.warning` path. Manifest count in the
 *     assembled doc reflects valid-only.
 *   - `mergeIntentGroups` mirrors Python exactly, including in-place
 *     mutation of the first-seen ref dicts when adding novel ranges.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from '@claude-prove/shared';
import { CURRENT_ACB_VERSION, validateManifest } from './schemas';
import type { AcbStore } from './store';

const logger = createLogger('acb.assembler');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AGENT_ID = 'prove-acb-v2';

// ---------------------------------------------------------------------------
// Types — structural shapes of ACB documents
// ---------------------------------------------------------------------------

export interface FileRef {
  path: string;
  ranges?: string[];
  [extra: string]: unknown;
}

export interface Annotation {
  id: string;
  type: string;
  body?: string;
  [extra: string]: unknown;
}

export interface IntentGroup {
  id: string;
  title: string;
  classification: string;
  ambiguity_tags: string[];
  task_grounding: string;
  file_refs: FileRef[];
  annotations: Annotation[];
}

export interface NegativeSpaceEntry {
  path: string;
  reason: string;
  body?: string;
  [extra: string]: unknown;
}

export interface OpenQuestion {
  id: string;
  body?: string;
  [extra: string]: unknown;
}

export interface ChangeSetRef {
  base_ref: string;
  head_ref: string;
}

export interface TaskStatement {
  turns: unknown[];
  [extra: string]: unknown;
}

export interface AcbDocument {
  acb_version: string;
  id: string;
  change_set_ref: ChangeSetRef;
  task_statement: TaskStatement;
  intent_groups: IntentGroup[];
  negative_space: NegativeSpaceEntry[];
  open_questions: OpenQuestion[];
  uncovered_files: string[];
  generated_at: string;
  agent_id: string;
  manifest_count: number;
}

export interface AssembleOpts {
  store: AcbStore;
  branch: string;
  baseRef: string;
  headRef?: string;
  taskStatement?: TaskStatement;
}

// ---------------------------------------------------------------------------
// Load + validate
// ---------------------------------------------------------------------------

/**
 * Load every manifest stored against `branch`, validate it, and return only
 * the valid ones. Invalid manifests are skipped with a `warn` log line —
 * matches `tools/acb/assembler.py::load_manifests_from_store`.
 */
export function loadManifestsFromStore(store: AcbStore, branch: string): Record<string, unknown>[] {
  const manifests: Record<string, unknown>[] = [];
  for (const raw of store.listManifests(branch)) {
    const errors = validateManifest(raw);
    if (errors.length > 0) {
      logger.warn(`Skipping invalid manifest: ${errors.join('; ')}`);
      continue;
    }
    // validateManifest only returns [] for plain-object inputs, so `raw`
    // is provably a Record here.
    manifests.push(raw as Record<string, unknown>);
  }
  return manifests;
}

// ---------------------------------------------------------------------------
// Merge intent groups
// ---------------------------------------------------------------------------

/**
 * Merge intent groups across manifests, keyed by `group.id`.
 *
 * First occurrence of a gid clones the group; subsequent occurrences
 * extend `file_refs` (dedup by path, merge `ranges` for same path),
 * `annotations` (dedup by id, first-wins), and `ambiguity_tags` (union
 * preserving first-seen order).
 */
export function mergeIntentGroups(manifests: Record<string, unknown>[]): IntentGroup[] {
  const merged = new Map<string, IntentGroup>();

  for (const manifest of manifests) {
    const groups = asArray(manifest.intent_groups);
    for (const rawGroup of groups) {
      if (!isRecord(rawGroup)) continue;
      const gid = asString(rawGroup.id);
      if (gid === null) continue;

      const existing = merged.get(gid);
      if (existing === undefined) {
        merged.set(gid, cloneGroupShell(gid, rawGroup));
        continue;
      }

      mergeFileRefs(existing, rawGroup);
      mergeAnnotations(existing, rawGroup);
      mergeAmbiguityTags(existing, rawGroup);
    }
  }

  return [...merged.values()];
}

function cloneGroupShell(gid: string, raw: Record<string, unknown>): IntentGroup {
  return {
    id: gid,
    title: asString(raw.title) ?? '',
    classification: asString(raw.classification) ?? '',
    ambiguity_tags: [...asStringArray(raw.ambiguity_tags)],
    task_grounding: asString(raw.task_grounding) ?? '',
    file_refs: [...asFileRefArray(raw.file_refs)],
    annotations: [...asAnnotationArray(raw.annotations)],
  };
}

function mergeFileRefs(existing: IntentGroup, incoming: Record<string, unknown>): void {
  const existingPaths = new Set(existing.file_refs.map((r) => r.path));
  const incomingRefs = asFileRefArray(incoming.file_refs);

  for (const ref of incomingRefs) {
    if (!existingPaths.has(ref.path)) {
      existing.file_refs.push(ref);
      existingPaths.add(ref.path);
      continue;
    }
    // Path already seen — merge ranges into the existing ref.
    const target = existing.file_refs.find((r) => r.path === ref.path);
    if (!target) continue;
    const seenRanges = new Set<string>(target.ranges ?? []);
    const incomingRanges = ref.ranges ?? [];
    for (const r of incomingRanges) {
      if (seenRanges.has(r)) continue;
      // Mirror Python's `eref.setdefault("ranges", []).append(r)` — lazily
      // create the ranges array on the target when absent.
      if (target.ranges === undefined) target.ranges = [];
      target.ranges.push(r);
      seenRanges.add(r);
    }
  }
}

function mergeAnnotations(existing: IntentGroup, incoming: Record<string, unknown>): void {
  const ids = new Set(existing.annotations.map((a) => a.id));
  const incomingAnns = asAnnotationArray(incoming.annotations);
  for (const ann of incomingAnns) {
    if (ids.has(ann.id)) continue;
    existing.annotations.push(ann);
    ids.add(ann.id);
  }
}

function mergeAmbiguityTags(existing: IntentGroup, incoming: Record<string, unknown>): void {
  const tagSet = new Set(existing.ambiguity_tags);
  const incomingTags = asStringArray(incoming.ambiguity_tags);
  for (const tag of incomingTags) {
    if (tagSet.has(tag)) continue;
    existing.ambiguity_tags.push(tag);
    tagSet.add(tag);
  }
}

// ---------------------------------------------------------------------------
// Negative space + open questions
// ---------------------------------------------------------------------------

/** Dedup by `path`, first-wins. Preserves iteration order across manifests. */
export function collectNegativeSpace(manifests: Record<string, unknown>[]): NegativeSpaceEntry[] {
  const seen = new Set<string>();
  const entries: NegativeSpaceEntry[] = [];
  for (const m of manifests) {
    const raw = asArray(m.negative_space);
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const path = asString(entry.path);
      if (path === null || seen.has(path)) continue;
      entries.push(entry as NegativeSpaceEntry);
      seen.add(path);
    }
  }
  return entries;
}

/** Dedup by `id`, first-wins. Preserves iteration order across manifests. */
export function collectOpenQuestions(manifests: Record<string, unknown>[]): OpenQuestion[] {
  const seen = new Set<string>();
  const questions: OpenQuestion[] = [];
  for (const m of manifests) {
    const raw = asArray(m.open_questions);
    for (const q of raw) {
      if (!isRecord(q)) continue;
      const id = asString(q.id);
      if (id === null || seen.has(id)) continue;
      questions.push(q as OpenQuestion);
      seen.add(id);
    }
  }
  return questions;
}

// ---------------------------------------------------------------------------
// Diff + uncovered files
// ---------------------------------------------------------------------------

/**
 * Run `git diff --name-only <baseRef>...HEAD` from `cwd` (or process.cwd()).
 * Returns the list of changed files, or `[]` on any git failure — matches
 * Python's `try/except CalledProcessError` branch.
 */
export function getDiffFiles(baseRef: string, cwd?: string): string[] {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync({
      cmd: ['git', 'diff', '--name-only', `${baseRef}...HEAD`],
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    });
  } catch {
    return [];
  }
  if (proc.exitCode !== 0) return [];
  const out = proc.stdout?.toString() ?? '';
  return out
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/**
 * Files in `diffFiles` that are NOT referenced by any intent group.
 * Preserves `diffFiles` order.
 */
export function detectUncoveredFiles(intentGroups: IntentGroup[], diffFiles: string[]): string[] {
  const covered = new Set<string>();
  for (const group of intentGroups) {
    for (const ref of group.file_refs) covered.add(ref.path);
  }
  return diffFiles.filter((f) => !covered.has(f));
}

// ---------------------------------------------------------------------------
// SHA-256 with deterministic sorted-keys serializer
// ---------------------------------------------------------------------------

/**
 * Byte-compatible equivalent of Python's
 * `hashlib.sha256(json.dumps(acb, sort_keys=True, separators=(',', ':')).encode()).hexdigest()`.
 *
 * Arrays preserve insertion order; objects serialize with keys in
 * lexicographic order; strings use the standard JSON escape sequences
 * Python emits with `ensure_ascii=True` (the default). Non-ASCII code
 * points are escaped as `\uXXXX` with surrogate pairs for astral
 * characters — parity fixtures exercise this path.
 */
export function computeAcbHash(acb: Record<string, unknown> | AcbDocument): string {
  const serialized = serializeSortedJson(acb);
  return createHash('sha256').update(serialized).digest('hex');
}

function serializeSortedJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return serializeNumber(value);
  if (typeof value === 'string') return encodeJsonString(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => serializeSortedJson(item));
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) continue;
      parts.push(`${encodeJsonString(key)}:${serializeSortedJson(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  // Numbers/bool/string/null/array/object are the only JSON-valid types;
  // anything else would diverge from Python's json.dumps.
  throw new TypeError(`Cannot serialize value of type ${typeof value}`);
}

function serializeNumber(n: number): string {
  // Python's json.dumps emits Infinity/NaN as the bareword "Infinity"/"NaN"
  // by default; that's invalid JSON, and ACB documents should never carry
  // them. Reject them explicitly rather than drift silently.
  if (!Number.isFinite(n)) {
    throw new TypeError(`Cannot serialize non-finite number: ${n}`);
  }
  if (Number.isInteger(n)) return n.toString();
  return String(n);
}

/**
 * JSON-string encoder matching Python's `json.dumps(..., ensure_ascii=True)`.
 *
 * Python escapes: `"`, `\`, and all control chars < 0x20 via named escapes
 * (`\b \f \n \r \t`) or `\u00XX`. Non-ASCII chars (>= 0x7f) are escaped as
 * `\uXXXX` with surrogate pairs for code points >= 0x10000.
 *
 * This is NOT V8's default `JSON.stringify` output — that leaves non-ASCII
 * as literal UTF-8 bytes. We reimplement the ASCII-safe escape here.
 */
function encodeJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    switch (code) {
      case 0x22: // "
        out += '\\"';
        continue;
      case 0x5c: // \
        out += '\\\\';
        continue;
      case 0x08: // backspace
        out += '\\b';
        continue;
      case 0x0c: // form feed
        out += '\\f';
        continue;
      case 0x0a:
        out += '\\n';
        continue;
      case 0x0d:
        out += '\\r';
        continue;
      case 0x09:
        out += '\\t';
        continue;
      default:
        break;
    }
    if (code < 0x20 || code >= 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += s[i];
  }
  out += '"';
  return out;
}

// ---------------------------------------------------------------------------
// assemble — top-level composition
// ---------------------------------------------------------------------------

/**
 * Assemble manifests for `branch` into a single ACB document. Top-level
 * orchestrator matching `tools/acb/assembler.py::assemble`.
 */
export function assemble(opts: AssembleOpts): AcbDocument {
  const { store, branch, baseRef, headRef, taskStatement } = opts;
  const manifests = loadManifestsFromStore(store, branch);
  const intentGroups = mergeIntentGroups(manifests);
  const negativeSpace = collectNegativeSpace(manifests);
  const openQuestions = collectOpenQuestions(manifests);
  const diffFiles = getDiffFiles(baseRef);
  const uncovered = detectUncoveredFiles(intentGroups, diffFiles);

  return {
    acb_version: CURRENT_ACB_VERSION,
    id: randomUUID(),
    change_set_ref: { base_ref: baseRef, head_ref: headRef ?? 'HEAD' },
    task_statement: taskStatement ?? { turns: [] },
    intent_groups: intentGroups,
    negative_space: negativeSpace,
    open_questions: openQuestions,
    uncovered_files: uncovered,
    generated_at: new Date().toISOString(),
    agent_id: AGENT_ID,
    manifest_count: manifests.length,
  };
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function asFileRefArray(value: unknown): FileRef[] {
  if (!Array.isArray(value)) return [];
  const out: FileRef[] = [];
  for (const ref of value) {
    if (!isRecord(ref)) continue;
    const path = asString(ref.path);
    if (path === null) continue;
    out.push(ref as FileRef);
  }
  return out;
}

function asAnnotationArray(value: unknown): Annotation[] {
  if (!Array.isArray(value)) return [];
  const out: Annotation[] = [];
  for (const ann of value) {
    if (!isRecord(ann)) continue;
    const id = asString(ann.id);
    if (id === null) continue;
    out.push(ann as Annotation);
  }
  return out;
}
