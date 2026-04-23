/**
 * JIT markdown rendering for run-state artifacts.
 *
 * Every human-readable view (`/prove:task progress`, run summary, handoff
 * context) is materialized from the underlying JSON. No markdown is
 * persisted — presentations are derived on demand so the JSON stays the
 * single source of truth.
 *
 * Ported 1:1 from `tools/run_state/render.py`. Byte-equal output vs the
 * Python source is load-bearing: agents read these views through
 * `scripts/prove-run show` and drift changes orchestrator behavior.
 */

import type { PlanData, PrdData, ReportData, StateData } from './state';

// ---------------------------------------------------------------------------
// Status badges — drive the checkbox/label prefixes used across every view.
// ---------------------------------------------------------------------------

export const STATUS_BADGES: Record<string, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
  failed: '[!]',
  halted: '[H]',
  skipped: '[-]',
  pass: 'PASS',
  fail: 'FAIL',
  approved: 'APPROVED',
  rejected: 'REJECTED',
  running: 'RUNNING',
  'n/a': 'N/A',
};

function badge(status: string): string {
  return STATUS_BADGES[status] ?? status;
}

// ---------------------------------------------------------------------------
// Rendering options
// ---------------------------------------------------------------------------

export type RenderFormat = 'md' | 'json';

export interface RenderStateOptions {
  format?: RenderFormat;
  /** Plan is consulted for task/step titles when rendering markdown. */
  plan?: PlanData | null;
}

export interface RenderPlanOptions {
  format?: RenderFormat;
}

export interface RenderPrdOptions {
  format?: RenderFormat;
}

export interface RenderReportOptions {
  format?: RenderFormat;
}

export interface RenderSummaryOptions {
  /** Reserved for parity — `render_summary` ignores plan content today. */
  plan?: PlanData | null;
}

export interface RenderCurrentOptions {
  format?: RenderFormat;
  plan?: PlanData | null;
}

// ---------------------------------------------------------------------------
// Shared JSON helper — matches Python's `json.dumps(data, indent=2)`
// (sort_keys=False, trailing newline, UTF-8).
// ---------------------------------------------------------------------------

function jsonDump(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function joinBlock(lines: readonly string[]): string {
  // Python: "\n".join(lines).rstrip() + "\n"
  // rstrip() strips trailing whitespace chars including newlines.
  return `${lines.join('\n').replace(/\s+$/, '')}\n`;
}

// ---------------------------------------------------------------------------
// PRD view
// ---------------------------------------------------------------------------

interface PrdView {
  title?: string;
  context?: string;
  goals?: string[];
  scope?: { in?: string[]; out?: string[] };
  acceptance_criteria?: string[];
  test_strategy?: string;
  body_markdown?: string;
}

/** Render a PRD as markdown or pretty-printed JSON. */
export function renderPrd(prd: PrdData, options: RenderPrdOptions = {}): string {
  const format = options.format ?? 'md';
  if (format === 'json') return jsonDump(prd);

  const view = prd as unknown as PrdView;
  const lines: string[] = [];
  lines.push(`# ${view.title ?? 'Untitled'}`);
  lines.push('');

  const context = view.context ?? '';
  if (context) {
    lines.push('## Context');
    lines.push('');
    lines.push(context);
    lines.push('');
  }

  const goals = view.goals ?? [];
  if (goals.length > 0) {
    lines.push('## Goals');
    lines.push('');
    for (const g of goals) lines.push(`- ${g}`);
    lines.push('');
  }

  const scope = view.scope ?? {};
  const inScope = scope.in ?? [];
  const outScope = scope.out ?? [];
  if (inScope.length > 0 || outScope.length > 0) {
    lines.push('## Scope');
    lines.push('');
    if (inScope.length > 0) {
      lines.push('**In scope**');
      for (const s of inScope) lines.push(`- ${s}`);
      lines.push('');
    }
    if (outScope.length > 0) {
      lines.push('**Out of scope**');
      for (const s of outScope) lines.push(`- ${s}`);
      lines.push('');
    }
  }

  const ac = view.acceptance_criteria ?? [];
  if (ac.length > 0) {
    lines.push('## Acceptance Criteria');
    lines.push('');
    for (const c of ac) lines.push(`- ${c}`);
    lines.push('');
  }

  const ts = view.test_strategy ?? '';
  if (ts) {
    lines.push('## Test Strategy');
    lines.push('');
    lines.push(ts);
    lines.push('');
  }

  const body = view.body_markdown ?? '';
  if (body) {
    lines.push(body.replace(/\s+$/, ''));
    lines.push('');
  }

  return joinBlock(lines);
}

// ---------------------------------------------------------------------------
// Plan view
// ---------------------------------------------------------------------------

interface PlanStepView {
  id: string;
  title: string;
}

interface PlanTaskView {
  id: string;
  title: string;
  wave?: number | string;
  deps?: string[];
  worktree?: { path?: string; branch?: string };
  description?: string;
  acceptance_criteria?: string[];
  steps?: PlanStepView[];
}

interface PlanView {
  mode?: string;
  tasks?: PlanTaskView[];
}

/** Render a plan as markdown or pretty-printed JSON. */
export function renderPlan(plan: PlanData, options: RenderPlanOptions = {}): string {
  const format = options.format ?? 'md';
  if (format === 'json') return jsonDump(plan);

  const view = plan as unknown as PlanView;
  const lines: string[] = [];
  const mode = view.mode ?? 'simple';
  lines.push(`# Task Plan (${mode} mode)`);
  lines.push('');

  const tasks = view.tasks ?? [];
  // Group by wave for readability — matches Python's dict.setdefault pattern.
  const waves = new Map<number, PlanTaskView[]>();
  for (const t of tasks) {
    const waveNum = Number.parseInt(String(t.wave ?? 1), 10);
    const bucket = waves.get(waveNum) ?? [];
    bucket.push(t);
    waves.set(waveNum, bucket);
  }

  const sortedWaves = [...waves.keys()].sort((a, b) => a - b);
  for (const wave of sortedWaves) {
    lines.push(`## Wave ${wave}`);
    lines.push('');
    for (const task of waves.get(wave) ?? []) {
      lines.push(`### Task ${task.id}: ${task.title}`);
      const deps = task.deps ?? [];
      if (deps.length > 0) {
        lines.push(`**Depends on:** ${deps.join(', ')}`);
      }
      const wt = task.worktree ?? {};
      if (wt.path || wt.branch) {
        lines.push(`**Worktree:** ${wt.path ?? ''}`);
        if (wt.branch) {
          lines.push(`**Branch:** ${wt.branch}`);
        }
      }
      const desc = task.description ?? '';
      if (desc) {
        lines.push('');
        lines.push(desc);
      }
      const ac = task.acceptance_criteria ?? [];
      if (ac.length > 0) {
        lines.push('');
        lines.push('**Acceptance Criteria**');
        for (const c of ac) lines.push(`- ${c}`);
      }
      const steps = task.steps ?? [];
      if (steps.length > 0) {
        lines.push('');
        lines.push('**Steps**');
        for (const s of steps) lines.push(`- \`${s.id}\` ${s.title}`);
      }
      lines.push('');
    }
  }

  return joinBlock(lines);
}

// ---------------------------------------------------------------------------
// State view
// ---------------------------------------------------------------------------

interface StateStepView {
  id: string;
  status: string;
  halt_reason?: string;
  validator_summary?: Record<string, string>;
}

interface StateReviewView {
  verdict?: string;
  notes?: string;
}

interface StateTaskView {
  id: string;
  status: string;
  review?: StateReviewView;
  steps?: StateStepView[];
}

interface StateView {
  slug?: string;
  branch?: string;
  run_status?: string;
  current_step?: string;
  started_at?: string;
  ended_at?: string;
  updated_at?: string;
  tasks?: StateTaskView[];
}

/** Render run state as markdown or pretty-printed JSON. */
export function renderState(state: StateData, options: RenderStateOptions = {}): string {
  const format = options.format ?? 'md';
  if (format === 'json') return jsonDump(state);

  const view = state as unknown as StateView;
  const lines: string[] = [];
  const slug = view.slug ?? '?';
  const branch = view.branch ?? '?';
  const runStatus = view.run_status ?? 'pending';
  lines.push(`# Run: ${branch}/${slug}`);
  lines.push('');
  lines.push(`**Status:** ${badge(runStatus)} \`${runStatus}\``);
  if (view.current_step) {
    lines.push(`**Current step:** \`${view.current_step}\``);
  }
  if (view.started_at) {
    lines.push(`**Started:** ${view.started_at}`);
  }
  if (view.ended_at) {
    lines.push(`**Ended:** ${view.ended_at}`);
  }
  lines.push(`**Updated:** ${view.updated_at ?? '?'}`);
  lines.push('');

  // Build a plan-id lookup for titles when plan is provided.
  const titles = new Map<string, string>();
  if (options.plan) {
    const planView = options.plan as unknown as PlanView;
    for (const t of planView.tasks ?? []) {
      titles.set(t.id, t.title ?? '');
      for (const s of t.steps ?? []) {
        titles.set(s.id, s.title ?? '');
      }
    }
  }

  const tasks = view.tasks ?? [];
  for (const task of tasks) {
    const tid = task.id;
    const ttitle = titles.get(tid) ?? '';
    const titleSuffix = ttitle ? `: ${ttitle}` : '';
    lines.push(`## Task ${tid} — ${badge(task.status)} \`${task.status}\`${titleSuffix}`);
    const review = task.review ?? {};
    if (review.verdict && review.verdict !== 'pending') {
      lines.push(`**Review:** ${badge(review.verdict)}`);
      if (review.notes) {
        lines.push(`  _${review.notes}_`);
      }
    }
    lines.push('');
    for (const step of task.steps ?? []) {
      const sid = step.id;
      const stitle = titles.get(sid) ?? '';
      lines.push(`- \`${sid}\` ${badge(step.status)} ${stitle}`);
      if (step.halt_reason) {
        lines.push(`  - halt: ${step.halt_reason}`);
      }
      const vs = step.validator_summary ?? {};
      const active: string[] = [];
      for (const [phase, stat] of Object.entries(vs)) {
        if (stat !== 'pending' && stat !== 'skipped') {
          active.push(`${phase}=${stat}`);
        }
      }
      if (active.length > 0) {
        lines.push(`  - validators: ${active.join(', ')}`);
      }
    }
    lines.push('');
  }

  return joinBlock(lines);
}

// ---------------------------------------------------------------------------
// Report view
// ---------------------------------------------------------------------------

interface ReportValidatorView {
  name?: string;
  phase?: string;
  status?: string;
  duration_s?: number;
  output?: string;
}

interface ReportView {
  step_id?: string;
  task_id?: string;
  status?: string;
  commit_sha?: string;
  started_at?: string;
  ended_at?: string;
  diff_stats?: { files_changed?: number; insertions?: number; deletions?: number };
  validators?: ReportValidatorView[];
  artifacts?: string[];
  notes?: string;
}

/** Render a per-step report as markdown or pretty-printed JSON. */
export function renderReport(report: ReportData, options: RenderReportOptions = {}): string {
  const format = options.format ?? 'md';
  if (format === 'json') return jsonDump(report);

  const view = report as unknown as ReportView;
  const lines: string[] = [];
  lines.push(`# Step Report: \`${view.step_id ?? '?'}\``);
  lines.push('');
  lines.push(`**Task:** \`${view.task_id ?? '?'}\``);
  lines.push(`**Status:** ${badge(view.status ?? '?')}`);
  if (view.commit_sha) lines.push(`**Commit:** \`${view.commit_sha}\``);
  if (view.started_at) lines.push(`**Started:** ${view.started_at}`);
  if (view.ended_at) lines.push(`**Ended:** ${view.ended_at}`);
  lines.push('');

  const diff = view.diff_stats ?? {};
  // Python: `any(diff.get(k) for k in (...))` — truthy check on each field.
  const hasDiff =
    Boolean(diff.files_changed) || Boolean(diff.insertions) || Boolean(diff.deletions);
  if (hasDiff) {
    lines.push(
      `**Diff:** ${diff.files_changed ?? 0} files, +${diff.insertions ?? 0} / -${diff.deletions ?? 0}`,
    );
    lines.push('');
  }

  const validators = view.validators ?? [];
  if (validators.length > 0) {
    lines.push('## Validators');
    lines.push('');
    for (const v of validators) {
      const dur = v.duration_s ?? 0;
      lines.push(`- **${v.name ?? '?'}** (${v.phase ?? '?'}): ${badge(v.status ?? '?')} (${dur}s)`);
      if (v.output && v.status === 'fail') {
        lines.push('```');
        lines.push(v.output.replace(/\s+$/, ''));
        lines.push('```');
      }
    }
    lines.push('');
  }

  const artifacts = view.artifacts ?? [];
  if (artifacts.length > 0) {
    lines.push('## Artifacts');
    lines.push('');
    for (const a of artifacts) lines.push(`- \`${a}\``);
    lines.push('');
  }

  const notes = view.notes ?? '';
  if (notes) {
    lines.push('## Notes');
    lines.push('');
    lines.push(notes.replace(/\s+$/, ''));
    lines.push('');
  }

  return joinBlock(lines);
}

// ---------------------------------------------------------------------------
// Summary view — single-block text used by /prove:task progress.
// ---------------------------------------------------------------------------

type CountKey = 'pending' | 'in_progress' | 'completed' | 'failed' | 'halted';
const COUNT_KEYS: readonly CountKey[] = ['pending', 'in_progress', 'completed', 'failed', 'halted'];

/**
 * One-screen status summary. Always plain text — Python callers do not
 * expose a JSON variant. The `plan` option is accepted for API symmetry
 * with Python but is not read (same as `render.py`).
 */
export function renderSummary(state: StateData, _options: RenderSummaryOptions = {}): string {
  const view = state as unknown as StateView;
  const tasks = view.tasks ?? [];

  const taskCounts: Record<CountKey, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    halted: 0,
  };
  const stepCounts: Record<CountKey, number> = { ...taskCounts };

  for (const t of tasks) {
    // Python does `counts[t["status"]] = counts.get(t["status"], 0) + 1` which
    // allows keys outside the preset set. We replicate with a loose record.
    incrementCount(taskCounts, t.status);
    for (const s of t.steps ?? []) {
      incrementCount(stepCounts, s.status);
    }
  }

  const lines: string[] = [];
  lines.push(`Run ${view.branch ?? '?'}/${view.slug ?? '?'}: ${view.run_status ?? '?'}`);
  lines.push(`Tasks — ${formatCounts(taskCounts)}`);
  lines.push(`Steps — ${formatCounts(stepCounts)}`);
  if (view.current_step) {
    lines.push(`Current: ${view.current_step}`);
  }
  return `${lines.join('\n')}\n`;
}

function incrementCount(target: Record<string, number>, status: string): void {
  target[status] = (target[status] ?? 0) + 1;
}

function formatCounts(counts: Record<string, number>): string {
  // Python uses dict-insertion order: the preset COUNT_KEYS are inserted
  // first, then any extras appear in the order they were first seen. We
  // iterate over Object.entries to get insertion order, filtering zero.
  const parts: string[] = [];
  for (const k of COUNT_KEYS) {
    const v = counts[k];
    if (v) parts.push(`${k}: ${v}`);
  }
  for (const [k, v] of Object.entries(counts)) {
    if ((COUNT_KEYS as readonly string[]).includes(k)) continue;
    if (v) parts.push(`${k}: ${v}`);
  }
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Current view — mirrors `cmd_current`: JSON dump or summary text.
// ---------------------------------------------------------------------------

/**
 * Mirror `tools/run_state/__main__.py::cmd_current`: JSON dump of the full
 * state when `format='json'`, otherwise the `renderSummary` text. Callers
 * pass the plan for symmetry; it is forwarded to `renderSummary` which
 * currently ignores it.
 */
export function renderCurrent(state: StateData, options: RenderCurrentOptions = {}): string {
  const format = options.format ?? 'md';
  if (format === 'json') return jsonDump(state);
  return renderSummary(state, { plan: options.plan ?? null });
}
