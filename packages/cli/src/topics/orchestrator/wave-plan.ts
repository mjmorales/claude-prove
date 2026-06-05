/**
 * `claude-prove orchestrator wave-plan --run-dir R [--max-agents N] [--format json|md]`
 *
 * Deterministic execution schedule for a compiled `plan.json`: groups tasks
 * into dependency waves and splits each wave into dispatch batches capped at
 * `--max-agents`. This is the substrate-agnostic kernel both `/prove:workflow`
 * backends consume — the native in-session loop and the `--backend dynamic` JS
 * driver schedule against the same projection. Also backs the skill's
 * `--dry-run` (render with `--format md`).
 *
 * The command is read-only and side-effect free: it reads `plan.json` and
 * emits a schedule. It does not dispatch agents or mutate run state.
 *
 * Stdout: JSON schedule (default) or a markdown dry-run table (`--format md`).
 * Stderr: one-line summary.
 *
 * Exit codes:
 *   0  success
 *   1  missing/invalid plan.json, or plan with no tasks
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { teamAgentNames } from '../scrum/team-agent-names';

export interface WavePlanOpts {
  runDir: string;
  maxAgents?: number;
  format?: 'json' | 'md';
}

interface PlanTask {
  id: string;
  title?: string;
  wave?: number;
  deps?: string[];
  team_slug?: string;
}

interface PlanShape {
  mode?: string;
  tasks?: PlanTask[];
}

interface WaveGroup {
  wave: number;
  tasks: string[];
  batches: string[][];
}

interface Schedule {
  run_dir: string;
  mode: string;
  max_agents: number | null;
  total_tasks: number;
  wave_count: number;
  dispatch_rounds: number;
  peak_concurrency: number;
  waves: WaveGroup[];
  warnings: string[];
  // Per-task role-bound agent roster, keyed by task id, for tasks that carry a
  // `team_slug`. Each value is the team's three deterministic agent names in
  // canonical role order (`team-<slug>-tech_lead|engineer|implementer`). The
  // batch dispatcher reads this to spawn role-bound agents per team-bound task;
  // team-less tasks contribute no key. Names are derived from the slug alone (no
  // store lookup), so a vacant seat still lists its deterministic name — seat
  // resolution is the agent's runtime concern.
  team_agents: Record<string, string[]>;
}

export function runWavePlan(opts: WavePlanOpts): number {
  const planPath = join(opts.runDir, 'plan.json');
  const plan = readJson<PlanShape>(planPath);
  if (!plan) {
    process.stderr.write(`ERROR: plan.json not found or invalid at ${planPath}\n`);
    return 1;
  }
  const tasks = plan.tasks ?? [];
  if (tasks.length === 0) {
    process.stderr.write(`ERROR: ${planPath} has no tasks to schedule\n`);
    return 1;
  }

  // Unlimited fan-out when the cap is absent or non-positive.
  const cap =
    opts.maxAgents !== undefined && opts.maxAgents > 0 ? Math.trunc(opts.maxAgents) : null;

  const schedule = buildSchedule(opts.runDir, plan.mode ?? 'simple', tasks, cap);

  if (opts.format === 'md') {
    process.stdout.write(renderMarkdown(schedule));
  } else {
    process.stdout.write(`${JSON.stringify(schedule)}\n`);
  }
  process.stderr.write(
    `orchestrator wave-plan: ${schedule.total_tasks} tasks, ${schedule.wave_count} waves, ` +
      `${schedule.dispatch_rounds} dispatch rounds, peak ${schedule.peak_concurrency}\n`,
  );
  return 0;
}

function buildSchedule(
  runDir: string,
  mode: string,
  tasks: PlanTask[],
  cap: number | null,
): Schedule {
  const ids = new Set(tasks.map((t) => String(t.id)));
  const waveOf = new Map<string, number>();
  for (const t of tasks) waveOf.set(String(t.id), t.wave ?? 1);

  const warnings = collectWarnings(tasks, ids, waveOf);

  const teamAgents = collectTeamAgents(tasks);

  // Group ids by wave, preserving plan order within each wave.
  const byWave = new Map<number, string[]>();
  for (const t of tasks) {
    const wave = t.wave ?? 1;
    const bucket = byWave.get(wave) ?? [];
    bucket.push(String(t.id));
    byWave.set(wave, bucket);
  }

  const waves: WaveGroup[] = [...byWave.keys()]
    .sort((a, b) => a - b)
    .map((wave) => {
      const waveTasks = byWave.get(wave) as string[];
      return { wave, tasks: waveTasks, batches: chunk(waveTasks, cap) };
    });

  const dispatchRounds = waves.reduce((sum, w) => sum + w.batches.length, 0);
  const peakConcurrency = waves.reduce(
    (max, w) => Math.max(max, ...w.batches.map((b) => b.length)),
    0,
  );

  return {
    run_dir: runDir,
    mode,
    max_agents: cap,
    total_tasks: tasks.length,
    wave_count: waves.length,
    dispatch_rounds: dispatchRounds,
    peak_concurrency: peakConcurrency,
    waves,
    warnings,
    team_agents: teamAgents,
  };
}

/**
 * Map each team-bound task id to its three role-bound agent names, in canonical
 * role order. Tasks without a `team_slug` contribute no entry, so a team-less
 * schedule yields an empty map and the batch dispatcher falls back to its
 * generic worker. Names are derived from the slug alone — no store lookup — so
 * every render surface agrees on the roster.
 */
function collectTeamAgents(tasks: PlanTask[]): Record<string, string[]> {
  const agents: Record<string, string[]> = {};
  for (const t of tasks) {
    if (t.team_slug) agents[String(t.id)] = teamAgentNames(t.team_slug);
  }
  return agents;
}

/**
 * Flag structural issues without failing: deps pointing at unknown tasks, and
 * deps that don't land in a strictly-earlier wave (which would break the
 * "all deps complete before this wave runs" invariant).
 */
function collectWarnings(
  tasks: PlanTask[],
  ids: Set<string>,
  waveOf: Map<string, number>,
): string[] {
  const warnings: string[] = [];
  for (const t of tasks) {
    const id = String(t.id);
    const wave = t.wave ?? 1;
    for (const dep of t.deps ?? []) {
      const depId = String(dep);
      if (!ids.has(depId)) {
        warnings.push(`task ${id} depends on unknown task ${depId}`);
        continue;
      }
      const depWave = waveOf.get(depId) ?? 1;
      if (depWave >= wave) {
        warnings.push(
          `task ${id} (wave ${wave}) depends on ${depId} (wave ${depWave}) — dep is not in an earlier wave`,
        );
      }
    }
  }
  return warnings;
}

function chunk(items: string[], size: number | null): string[][] {
  if (size === null || items.length <= size) return [items];
  const out: string[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function renderMarkdown(s: Schedule): string {
  const lines: string[] = [];
  lines.push('# Workflow dry-run');
  lines.push('');
  lines.push(`- **Run dir**: ${s.run_dir}`);
  lines.push(`- **Mode**: ${s.mode}`);
  lines.push(`- **Fan-out cap**: ${s.max_agents === null ? 'unlimited' : s.max_agents}`);
  lines.push(`- **Tasks**: ${s.total_tasks} across ${s.wave_count} waves`);
  lines.push(
    `- **Dispatch rounds**: ${s.dispatch_rounds} (peak concurrency ${s.peak_concurrency})`,
  );
  lines.push('');
  lines.push('| Wave | Batch | Tasks | Team Agents |');
  lines.push('|------|-------|-------|-------------|');
  for (const w of s.waves) {
    w.batches.forEach((batch, idx) => {
      const agents = renderBatchAgents(batch, s.team_agents);
      lines.push(
        `| ${w.wave} | ${idx + 1}/${w.batches.length} | ${batch.join(', ')} | ${agents} |`,
      );
    });
  }
  if (s.warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    lines.push('');
    for (const warn of s.warnings) lines.push(`- ⚠️ ${warn}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The dry-run "Team Agents" cell for one dispatch batch: each team-bound task in
 * the batch contributes `id: <tech_lead>, <engineer>, <implementer>`, joined by
 * `; `. A batch with no team-bound tasks renders an em-dash. Names come from the
 * schedule's `team_agents` map, so the dry-run and the JSON schedule agree.
 */
function renderBatchAgents(batch: string[], teamAgents: Record<string, string[]>): string {
  const parts: string[] = [];
  for (const id of batch) {
    const names = teamAgents[id];
    if (names) parts.push(`${id}: ${names.join(', ')}`);
  }
  return parts.length > 0 ? parts.join('; ') : '—';
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
