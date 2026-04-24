/**
 * One-shot migrators for legacy `.prove/runs/<branch>/<slug>/` layouts.
 *
 * Ported 1:1 from `tools/run_state/migrate.py`. Converts the legacy
 * markdown-first structure
 *
 *   .prove/runs/<branch>/<slug>/
 *     PRD.md
 *     TASK_PLAN.md
 *     PROGRESS.md           (optional)
 *     dispatch-state.json   (optional)
 *     reports/              (preserved as-is)
 *
 * into the JSON-first shape
 *
 *   .prove/runs/<branch>/<slug>/
 *     prd.json
 *     plan.json
 *     state.json
 *     reports/              (new JSON reports added alongside legacy files)
 *
 * Markdown parsing is deliberately tolerant — extract what we can and
 * preserve the original body under `body_markdown` / `description` so no
 * information is lost. Legacy files are NOT deleted; callers decide.
 *
 * This module is standalone on purpose — it inlines `newPrd` / `newPlan`
 * / `newState` / `utcnowIso` / `_writeJsonAtomic` from `state.py` so the
 * migrate entrypoint has zero dependency on the still-in-flight state
 * port (Task 2). The factory helpers mirror Python construction order
 * exactly so JSON key order matches byte-for-byte.
 *
 * Note: the task brief described a schema-version migration chain. The
 * actual Python source is a markdown→JSON converter, not a chain — there
 * is one schema version (v1) and no `MIGRATIONS` registry. This port
 * preserves Python semantics faithfully; see `tools/run_state/migrate.py`
 * and `.prove/decisions/2026-04-17-prove-runs-json-first.md` for intent.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { RunPathsData } from './paths';
import {
  type DispatchLedger,
  type PlanData,
  type PrdData,
  type StateData,
  type TaskData,
  _clock,
  deepCloneJson,
  defaultsFromSchema,
  newPlan as stateNewPlan,
  newPrd as stateNewPrd,
  newState as stateNewState,
  utcnowIso,
  writeJsonAtomic,
} from './state';

// --------------------------------------------------------------------------
// Re-exports — a single source of truth lives in state.ts. The alias
// wrappers below keep the `migrate.*` import surface stable for callers
// (Python tests used a local `migrate.utcnow_iso` monkeypatch, the TS
// equivalent just reads through to `state._clock`).
// --------------------------------------------------------------------------

export { _clock, deepCloneJson, defaultsFromSchema, utcnowIso, writeJsonAtomic };

/**
 * Raised when the legacy markdown input cannot be translated into a valid
 * JSON artifact — typically because the parsed plan is missing required
 * fields (`tasks` array, task `id`, step `id`). Surfaces the offending
 * field so callers can point at the bad source file.
 */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * Build a fresh prd.json payload. Thin passthrough to the canonical factory
 * in `state.ts`; exported from this module so tests and migrate call sites
 * share one construction path (and thus one key order).
 */
export function newPrd(title: string, overrides: Record<string, unknown> = {}): PrdData {
  return stateNewPrd(title, overrides);
}

export function newPlan(tasks: PlanData['tasks'], mode = 'simple'): PlanData {
  return stateNewPlan(tasks, mode);
}

/**
 * Markdown-tolerant `newState` wrapper. Accepts the untyped dict shape
 * the markdown parsers produce; validates the minimal plan shape then
 * delegates to the canonical builder in `state.ts` so key order / on-disk
 * bytes stay identical.
 */
export function newState(slug: string, branch: string, plan: Record<string, unknown>): StateData {
  return stateNewState(slug, branch, coercePlan(plan));
}

/**
 * Narrow a markdown-parsed dict into a `PlanData` shape. The parsers in
 * this file build plans field-by-field, so `tasks` is always present when
 * the markdown is well-formed; this guard raises `MigrationError` rather
 * than allowing a silently-malformed plan to flow into `state.json`.
 */
function coercePlan(plan: Record<string, unknown>): PlanData {
  if (!Array.isArray(plan.tasks)) {
    throw new MigrationError(
      "plan is missing 'tasks' array (expected PlanData shape from parsePlanMd)",
    );
  }
  return plan as unknown as PlanData;
}

// --------------------------------------------------------------------------
// Markdown regex primitives — mirrors migrate.py module-level regexes.
//
// WARNING: these regexes all carry the `g` flag and are safe only because
// callers use `String.prototype.matchAll` (stateless). Do NOT switch to
// `.exec()` in a loop — the global flag causes `lastIndex` to carry
// between calls and produces silent misparses on the second pass.
// --------------------------------------------------------------------------

// H1 title: "# Task Plan: ..." or "# <anything>"
const H1_RE = /^#\s+(.+)$/m;

// "### Task 1.2: Something"
const TASK_RE = /^###\s+Task\s+(\d+(?:\.\d+)+):\s*(.+?)\s*$/gm;

// "#### Step 1.2.3: Something" (optional sub-steps)
const STEP_RE = /^####\s+Step\s+(\d+(?:\.\d+)+):\s*(.+?)\s*$/gm;

// "**Worktree:** /path/to/worktree"
const WORKTREE_RE = /^\*\*Worktree:\*\*\s*(.+?)\s*$/m;
const BRANCH_RE = /^\*\*Branch:\*\*\s*(.+?)\s*$/m;
const DEPS_RE = /^\*\*(?:Depends on|Dependencies):\*\*\s*(.+?)\s*$/m;

// "## Section Heading"
const SECTION_RE = /^##\s+(.+?)\s*$/gm;

// "- bullet" or "* bullet"
const BULLET_RE = /^\s*[-*]\s+(.+?)\s*$/gm;

// Progress line: "- [x] Task 1.2 ..."
const CHECK_TASK_RE = /^- \[([ x!H~\-])\]\s+(?:Task\s+)?(\d+(?:\.\d+)+)/gm;

// --------------------------------------------------------------------------
// PRD
// --------------------------------------------------------------------------

/** Parse a legacy PRD.md into the prd.json shape (loose heuristics). */
export function parsePrdMd(text: string): Record<string, unknown> {
  const titleMatch = text.match(H1_RE);
  const title = titleMatch?.[1] ? titleMatch[1].trim() : 'Untitled Run';

  const sections = splitSections(text);
  const context = firstPresent(sections, ['Context', 'Problem', 'Background', 'Summary']);
  const goals = extractBullets(firstPresent(sections, ['Goals', 'Objectives']) ?? '');
  const inScope = extractBullets(firstPresent(sections, ['In Scope', 'Scope / In']) ?? '');
  const outScope = extractBullets(firstPresent(sections, ['Out of Scope', 'Out-of-Scope']) ?? '');
  const acceptance = extractBullets(
    firstPresent(sections, ['Acceptance Criteria', 'Acceptance']) ?? '',
  );
  const testStrategy = firstPresent(sections, ['Test Strategy', 'Testing', 'Tests']) ?? '';

  return newPrd(title, {
    context: context ?? '',
    goals,
    scope: { in: inScope, out: outScope },
    acceptance_criteria: acceptance,
    test_strategy: testStrategy,
    body_markdown: text.trim(),
  });
}

// --------------------------------------------------------------------------
// Plan
// --------------------------------------------------------------------------

/** Parse a legacy TASK_PLAN.md into the plan.json shape. */
export function parsePlanMd(text: string): Record<string, unknown> {
  const matches = Array.from(text.matchAll(TASK_RE));
  const tasks: Record<string, unknown>[] = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m || m.index === undefined) continue;
    const taskId = (m[1] ?? '').trim();
    const title = (m[2] ?? '').trim();
    const start = m.index + m[0].length;
    const nextMatch = matches[i + 1];
    const end = nextMatch && nextMatch.index !== undefined ? nextMatch.index : text.length;
    const body = text.slice(start, end).trim();

    const wave = Number.parseInt(taskId.split('.')[0] ?? '0', 10);

    const wtMatch = body.match(WORKTREE_RE);
    const brMatch = body.match(BRANCH_RE);
    const depsMatch = body.match(DEPS_RE);
    const deps = depsMatch?.[1]
      ? depsMatch[1]
          .split(',')
          .map((d) => d.trim())
          .filter((d) => d.length > 0)
      : [];

    // Sub-steps inside the task body (optional)
    const stepMatches = Array.from(body.matchAll(STEP_RE));
    const steps: Record<string, unknown>[] = [];

    if (stepMatches.length > 0) {
      for (let j = 0; j < stepMatches.length; j++) {
        const sm = stepMatches[j];
        if (!sm || sm.index === undefined) continue;
        const sId = (sm[1] ?? '').trim();
        const sTitle = (sm[2] ?? '').trim();
        const sStart = sm.index + sm[0].length;
        const nextStep = stepMatches[j + 1];
        const sEnd = nextStep && nextStep.index !== undefined ? nextStep.index : body.length;
        const sDesc = body.slice(sStart, sEnd).trim();
        steps.push({
          id: sId,
          title: sTitle,
          description: sDesc,
          acceptance_criteria: [],
        });
      }
    } else {
      // One implicit step — whole task body is the step description.
      steps.push({
        id: `${taskId}.1`,
        title,
        description: body,
        acceptance_criteria: [],
      });
    }

    tasks.push({
      id: taskId,
      title,
      wave,
      deps,
      description: body,
      acceptance_criteria: [],
      worktree: {
        path: wtMatch?.[1] ? wtMatch[1].trim() : '',
        branch: brMatch?.[1] ? brMatch[1].trim() : '',
      },
      steps,
    });
  }

  const mode = tasks.some((t) => Number(t.wave) > 1) ? 'full' : 'simple';
  // Markdown parsing built each task field-by-field against PlanTaskInput;
  // structural match is verified by the parity fixtures.
  return newPlan(tasks as unknown as PlanData['tasks'], mode);
}

// --------------------------------------------------------------------------
// State (from PROGRESS.md checklist + plan)
// --------------------------------------------------------------------------

/**
 * Best-effort translation of a PROGRESS.md checklist into state.json.
 * Unmatched tasks keep their default `pending` status.
 *
 * Input-shape discipline: `newState` guarantees a well-formed `StateData`
 * output so bracket-notation writes are replaced by typed field access —
 * the compiler now rejects value drift. Callers passing a malformed plan
 * surface as `MigrationError` from `newState`, never silent corruption.
 */
export function deriveStateFromProgress(
  progressText: string,
  plan: Record<string, unknown>,
  slug: string,
  branch: string,
): StateData {
  const state = newState(slug, branch, plan);

  // Parse checkmarks into a {taskId: status} map.
  const statuses: Record<string, ProgressMark> = {};
  for (const m of progressText.matchAll(CHECK_TASK_RE)) {
    const mark = m[1] ?? ' ';
    const tid = m[2];
    if (!tid) continue;
    statuses[tid] = markToStatus(mark);
  }

  let anyInProgress = false;

  for (const task of state.tasks) {
    const s = statuses[task.id];
    if (!s) continue;
    // 'skipped' is a step-only status and 'pending' is a no-op default —
    // filter to the four marks that legally transition a task.
    if (!TASK_MARKS.has(s)) continue;
    task.status = s as TaskData['status'];

    // Propagate a sensible default to steps: completed tasks mark steps
    // completed, in_progress leaves steps pending, failed/halted mark
    // the task end-time but leave steps for the caller.
    if (s === 'completed') {
      for (const step of task.steps) {
        step.status = 'completed';
        step.ended_at = utcnowIso();
      }
      task.ended_at = utcnowIso();
    } else if (s === 'in_progress') {
      anyInProgress = true;
    } else if (s === 'failed' || s === 'halted') {
      task.ended_at = utcnowIso();
    }
  }

  if (anyInProgress) {
    state.run_status = 'running';
  } else if (state.tasks.length > 0 && state.tasks.every((t) => t.status === 'completed')) {
    state.run_status = 'completed';
    state.ended_at = utcnowIso();
  }

  return state;
}

type ProgressMark = 'pending' | 'completed' | 'failed' | 'halted' | 'in_progress' | 'skipped';

/** Marks that legally land on `TaskData.status`. Other marks are ignored. */
const TASK_MARKS: ReadonlySet<ProgressMark> = new Set([
  'completed',
  'failed',
  'halted',
  'in_progress',
]);

function markToStatus(mark: string): ProgressMark {
  switch (mark) {
    case ' ':
      return 'pending';
    case 'x':
      return 'completed';
    case '!':
      return 'failed';
    case 'H':
      return 'halted';
    case '~':
      return 'in_progress';
    case '-':
      return 'skipped';
    default:
      return 'pending';
  }
}

// --------------------------------------------------------------------------
// Migration driver
// --------------------------------------------------------------------------

export interface MigrationResult {
  runDir: string;
  prdWritten: boolean;
  planWritten: boolean;
  stateWritten: boolean;
  tasksFound: number;
  stepsFound: number;
}

export interface MigrateRunOptions {
  branch: string;
  slug: string;
  dryRun?: boolean;
  overwrite?: boolean;
}

/** Convert a single run directory to the JSON-first layout. */
export function migrateRun(runDir: string, opts: MigrateRunOptions): MigrationResult {
  const { branch, slug, dryRun = false, overwrite = false } = opts;

  const prdMd = join(runDir, 'PRD.md');
  const planMd = join(runDir, 'TASK_PLAN.md');
  const progressMd = join(runDir, 'PROGRESS.md');
  const dispatchLegacy = join(runDir, 'dispatch-state.json');

  // `migrateRun` takes a pre-resolved run dir rather than `(runsRoot,
  // branch, slug)`, so we compute paths inline against the canonical
  // `RunPathsData` shape from `./paths` instead of calling `forRun`.
  const paths: RunPathsData = {
    root: runDir,
    prd: join(runDir, 'prd.json'),
    plan: join(runDir, 'plan.json'),
    state: join(runDir, 'state.json'),
    state_lock: join(runDir, 'state.json.lock'),
    reports_dir: join(runDir, 'reports'),
  };

  // PRD
  let prdWritten = false;
  if (existsSync(prdMd) && (!existsSync(paths.prd) || overwrite)) {
    const prd = parsePrdMd(readFileSync(prdMd, 'utf8'));
    if (!dryRun) writeJsonAtomic(paths.prd, prd);
    prdWritten = true;
  }

  // Plan
  let plan: Record<string, unknown> | null = null;
  let planWritten = false;
  if (existsSync(planMd) && (!existsSync(paths.plan) || overwrite)) {
    plan = parsePlanMd(readFileSync(planMd, 'utf8'));
    if (!dryRun) writeJsonAtomic(paths.plan, plan);
    planWritten = true;
  } else if (existsSync(paths.plan)) {
    plan = JSON.parse(readFileSync(paths.plan, 'utf8')) as Record<string, unknown>;
  }

  // State
  let stateWritten = false;
  if (plan !== null && (!existsSync(paths.state) || overwrite)) {
    const state = existsSync(progressMd)
      ? deriveStateFromProgress(readFileSync(progressMd, 'utf8'), plan, slug, branch)
      : newState(slug, branch, plan);

    // Fold legacy dispatch-state.json into state.dispatch.
    if (existsSync(dispatchLegacy)) {
      try {
        const legacy = JSON.parse(readFileSync(dispatchLegacy, 'utf8')) as Record<string, unknown>;
        if (Array.isArray(legacy.dispatched)) {
          // `newState` always seeds `state.dispatch = { dispatched: [] }`,
          // so no re-initialization guard is needed here.
          state.dispatch.dispatched = [
            ...state.dispatch.dispatched,
            ...(legacy.dispatched as DispatchLedger['dispatched']),
          ];
        }
      } catch {
        // Malformed legacy file — skip silently, mirrors Python's except JSONDecodeError.
      }
    }

    if (!dryRun) writeJsonAtomic(paths.state, state);
    stateWritten = true;
  }

  const planTasks = plan ? ((plan.tasks as unknown[]) ?? []) : [];
  const tasksFound = planTasks.length;
  let stepsFound = 0;
  for (const t of planTasks) {
    const steps = (t as Record<string, unknown>).steps;
    if (Array.isArray(steps)) stepsFound += steps.length;
  }

  return { runDir, prdWritten, planWritten, stateWritten, tasksFound, stepsFound };
}

export interface MigrateAllOptions {
  dryRun?: boolean;
  overwrite?: boolean;
}

/**
 * Walk `.prove/runs/` and migrate every leaf run directory found.
 * A leaf is any directory containing `TASK_PLAN.md` or `PRD.md`. The
 * branch is the first path component below `runsRoot`; the slug is the
 * run directory name.
 */
export function migrateAll(runsRoot: string, opts: MigrateAllOptions = {}): MigrationResult[] {
  const results: MigrationResult[] = [];
  if (!existsSync(runsRoot)) return results;

  const absRoot = resolve(runsRoot);
  const leaves = iterRunDirs(absRoot).sort();

  for (const path of leaves) {
    const rel = relative(absRoot, path).split(sep).filter(Boolean);
    let branch: string;
    let slug: string;
    if (rel.length === 1) {
      // legacy top-level run (no branch namespace)
      branch = 'main';
      slug = rel[0] ?? '';
    } else {
      branch = rel[0] ?? 'main';
      slug = rel[rel.length - 1] ?? '';
    }
    results.push(
      migrateRun(path, {
        branch,
        slug,
        dryRun: opts.dryRun,
        overwrite: opts.overwrite,
      }),
    );
  }

  return results;
}

function iterRunDirs(root: string): string[] {
  const out: string[] = [];
  walk(root, out);
  return out;
}

function walk(dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const hasLegacy = existsSync(join(dir, 'TASK_PLAN.md')) || existsSync(join(dir, 'PRD.md'));
  if (hasLegacy) acc.push(dir);
  for (const name of entries) {
    const child = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(child);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(child, acc);
  }
}

// --------------------------------------------------------------------------
// Markdown section helpers
// --------------------------------------------------------------------------

/** Split markdown by `##` headings; return `{heading: body}`. */
function splitSections(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const matches = Array.from(text.matchAll(SECTION_RE));
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m || m.index === undefined) continue;
    const heading = (m[1] ?? '').trim();
    const start = m.index + m[0].length;
    const next = matches[i + 1];
    const end = next && next.index !== undefined ? next.index : text.length;
    out[heading] = text.slice(start, end).trim();
  }
  return out;
}

function firstPresent(sections: Record<string, string>, candidates: string[]): string | null {
  for (const name of candidates) {
    const hit = sections[name];
    if (hit !== undefined) return hit;
  }
  // Case-insensitive fallback
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(sections)) {
    lower[k.toLowerCase()] = v;
  }
  for (const name of candidates) {
    const hit = lower[name.toLowerCase()];
    if (hit !== undefined) return hit;
  }
  return null;
}

function extractBullets(text: string): string[] {
  return Array.from(text.matchAll(BULLET_RE)).map((m) => (m[1] ?? '').trim());
}
