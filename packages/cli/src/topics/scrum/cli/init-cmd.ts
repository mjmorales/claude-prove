/**
 * `prove scrum init [--workspace-root W]`
 *
 * One-shot importer that seeds the scrum tables from legacy planning
 * artifacts:
 *   - planning/ROADMAP.md       -> scrum_milestones + scrum_tasks
 *   - planning/BACKLOG.md       -> scrum_tasks (status = 'backlog')
 *   - planning/ship-log.md      -> scrum_tasks (status = 'done') + events
 *   - planning/decisions/*.md   -> scrum_events (kind = 'decision_linked')
 *
 * Idempotent: if the store already has any rows in `scrum_tasks`, the
 * subcommand short-circuits — it never re-imports or mutates existing
 * data. Empty planning/ is a clean no-op that exits 0.
 *
 * `VISION.md` is preserved by design — it is strategic narrative, not a
 * task queue. Every other recognized file under `planning/` is deleted
 * after a successful seed.
 *
 * Exit codes:
 *   0  seeded successfully, already-seeded (no-op), or empty planning/
 *   1  workspace root unresolvable or parse I/O error
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { type ScrumStore, openScrumStore } from '../store';

export interface InitCmdFlags {
  workspaceRoot?: string;
}

interface ImportSummary {
  milestones: number;
  tasks: number;
  events: number;
  deletedFiles: string[];
}

export function runInitCmd(flags: InitCmdFlags): number {
  const workspaceRoot = resolveWorkspaceRoot(flags.workspaceRoot);

  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  try {
    if (hasExistingTasks(store)) {
      process.stdout.write(`${JSON.stringify({ seeded: false, reason: 'already-seeded' })}\n`);
      process.stderr.write('scrum init: store already has tasks, skipping import\n');
      return 0;
    }

    const planningDir = join(workspaceRoot, 'planning');
    if (!hasPlanningContent(planningDir)) {
      process.stdout.write(`${JSON.stringify({ seeded: false, reason: 'empty' })}\n`);
      process.stderr.write('scrum init: nothing to import (planning/ empty or absent)\n');
      return 0;
    }

    const summary = importPlanning(store, planningDir);
    cleanupLegacyFiles(workspaceRoot, summary);

    process.stdout.write(
      `${JSON.stringify({
        seeded: true,
        milestones: summary.milestones,
        tasks: summary.tasks,
        events: summary.events,
        deleted_files: summary.deletedFiles,
      })}\n`,
    );
    process.stderr.write(
      `scrum init: imported ${summary.tasks} tasks, ${summary.milestones} milestones, ${summary.events} events\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}

function resolveWorkspaceRoot(flag: string | undefined): string {
  if (flag !== undefined && flag.length > 0) return flag;
  return mainWorktreeRoot() ?? process.cwd();
}

function hasExistingTasks(store: ScrumStore): boolean {
  return store.listTasks().length > 0;
}

/**
 * Planning dir is "empty" if it's missing OR contains only VISION.md.
 * Returns true when at least one importable artifact is present.
 */
function hasPlanningContent(planningDir: string): boolean {
  if (!existsSync(planningDir)) return false;
  const roadmap = join(planningDir, 'ROADMAP.md');
  const backlog = join(planningDir, 'BACKLOG.md');
  const shipLog = join(planningDir, 'ship-log.md');
  const decisionsDir = join(planningDir, 'decisions');
  return (
    existsSync(roadmap) ||
    existsSync(backlog) ||
    existsSync(shipLog) ||
    (existsSync(decisionsDir) && statSync(decisionsDir).isDirectory())
  );
}

function importPlanning(store: ScrumStore, planningDir: string): ImportSummary {
  const summary: ImportSummary = { milestones: 0, tasks: 0, events: 0, deletedFiles: [] };
  const declaredMilestones = new Set<string>();
  const roadmapIces = new Set<number>();

  const roadmapPath = join(planningDir, 'ROADMAP.md');
  if (existsSync(roadmapPath)) {
    const roadmap = parseRoadmap(readFileSync(roadmapPath, 'utf8'));
    for (const milestone of roadmap.milestones) {
      store.createMilestone({ id: milestone.id, title: milestone.title, status: 'planned' });
      declaredMilestones.add(milestone.id);
      summary.milestones += 1;
    }
    for (const task of roadmap.tasks) {
      const resolvedMilestoneId = ensureMilestone(
        store,
        task.milestoneId,
        declaredMilestones,
        summary,
      );
      store.createTask({
        id: task.id,
        title: task.title,
        milestoneId: resolvedMilestoneId,
        status: 'backlog',
      });
      const ice = extractIce(task.title);
      if (ice !== null) roadmapIces.add(ice);
      summary.tasks += 1;
    }
    summary.deletedFiles.push('planning/ROADMAP.md');
  }

  const backlogPath = join(planningDir, 'BACKLOG.md');
  if (existsSync(backlogPath)) {
    const items = parseBulletList(readFileSync(backlogPath, 'utf8'));
    for (const [idx, title] of items.entries()) {
      const ice = extractIce(title);
      if (ice !== null && roadmapIces.has(ice)) continue; // dedup ROADMAP <> BACKLOG
      const id = slugifyWithIndex('backlog', title, idx);
      const milestoneRef = extractMilestoneRef(title);
      const resolvedMilestoneId = ensureMilestone(store, milestoneRef, declaredMilestones, summary);
      store.createTask({ id, title, milestoneId: resolvedMilestoneId, status: 'backlog' });
      summary.tasks += 1;
    }
    summary.deletedFiles.push('planning/BACKLOG.md');
  }

  const shipLogPath = join(planningDir, 'ship-log.md');
  if (existsSync(shipLogPath)) {
    const items = parseBulletList(readFileSync(shipLogPath, 'utf8'));
    for (const [idx, title] of items.entries()) {
      const id = slugifyWithIndex('shipped', title, idx);
      store.createTask({ id, title, status: 'backlog' });
      // Transition backlog -> ready -> in_progress -> done so the lifecycle
      // guard in updateTaskStatus is satisfied and we emit real events.
      store.updateTaskStatus(id, 'ready');
      store.updateTaskStatus(id, 'in_progress');
      store.updateTaskStatus(id, 'done');
      summary.tasks += 1;
      summary.events += 3;
    }
    summary.deletedFiles.push('planning/ship-log.md');
  }

  const decisionsDir = join(planningDir, 'decisions');
  if (existsSync(decisionsDir) && statSync(decisionsDir).isDirectory()) {
    // Decisions attach to the first task if any exist; otherwise they
    // land as free-floating log lines we can't attach without a task id.
    // We skip persistence in that case so the FK stays honest, but warn
    // loudly so the drop is not silent.
    const tasks = store.listTasks();
    const firstTaskId = tasks[0]?.id;
    const decisionFiles = readdirSync(decisionsDir).filter((f) => f.endsWith('.md'));
    if (firstTaskId !== undefined) {
      for (const file of decisionFiles) {
        store.appendEvent({
          taskId: firstTaskId,
          kind: 'decision_linked',
          payload: { decision_path: join('planning', 'decisions', file) },
        });
        summary.events += 1;
      }
    } else if (decisionFiles.length > 0) {
      console.warn(
        `scrum init: dropped ${decisionFiles.length} decision event(s) — no tasks exist to anchor them (FK requires a task id)`,
      );
    }
    summary.deletedFiles.push('planning/decisions');
  }

  return summary;
}

function cleanupLegacyFiles(workspaceRoot: string, summary: ImportSummary): void {
  for (const rel of summary.deletedFiles) {
    const abs = join(workspaceRoot, rel);
    try {
      rmSync(abs, { recursive: true, force: true });
    } catch {
      // Best-effort — the import already succeeded, so a failed cleanup
      // shouldn't fail the command.
    }
  }
}

/**
 * Best-effort ROADMAP.md parser.
 *
 * Recognizes two milestone-heading shapes:
 *   - `## Milestone: <Title>`     — canonical form, id from `<Title>`
 *   - `## M<n> <rest>` / `## M<n>: <rest>` — section-anchor form, id = `m<n>`
 *
 * Bullets under a milestone heading become tasks belonging to that
 * milestone. The parser rejects noise rows (section headers, dependency
 * prose, empty bullets) via `isNoiseRow`. Tasks whose title carries a
 * `M<n>` token override the enclosing heading when the two disagree —
 * this matches how the filer's glib-lang ROADMAP was laid out.
 */
function parseRoadmap(content: string): {
  milestones: Array<{ id: string; title: string }>;
  tasks: Array<{ id: string; title: string; milestoneId: string | null }>;
} {
  const milestones: Array<{ id: string; title: string }> = [];
  const tasks: Array<{ id: string; title: string; milestoneId: string | null }> = [];
  const seenMilestoneIds = new Set<string>();
  let currentMilestone: string | null = null;
  let taskIdx = 0;

  const pushMilestone = (id: string, title: string) => {
    if (seenMilestoneIds.has(id)) return;
    seenMilestoneIds.add(id);
    milestones.push({ id, title });
  };

  for (const line of content.split('\n')) {
    const milestoneMatch = /^##\s+Milestone:\s+(.+?)\s*$/i.exec(line);
    if (milestoneMatch?.[1] !== undefined) {
      const title = milestoneMatch[1];
      const id = slugify(title);
      pushMilestone(id, title);
      currentMilestone = id;
      continue;
    }
    const anchorMatch = /^##\s+(M\d+)\b[:\s-]*\s*(.*)$/i.exec(line);
    if (anchorMatch?.[1] !== undefined) {
      const id = anchorMatch[1].toLowerCase();
      const rest = (anchorMatch[2] ?? '').trim();
      pushMilestone(id, rest.length > 0 ? `${anchorMatch[1]} ${rest}` : anchorMatch[1]);
      currentMilestone = id;
      continue;
    }
    const taskMatch = /^\s*-\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    if (taskMatch?.[1] !== undefined) {
      const title = taskMatch[1];
      if (!looksLikeTask(title)) continue;
      const id = slugifyWithIndex('roadmap', title, taskIdx);
      const milestoneRef = extractMilestoneRef(title) ?? currentMilestone;
      tasks.push({ id, title, milestoneId: milestoneRef });
      taskIdx += 1;
    }
  }
  return { milestones, tasks };
}

/**
 * Parse every `- <title>` bullet from markdown, filtering noise rows.
 * Dependency-prose lines and bare section headers never reach the store.
 */
function parseBulletList(content: string): string[] {
  const items: string[] = [];
  for (const line of content.split('\n')) {
    const match = /^\s*-\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    const title = match?.[1];
    if (title === undefined || title.length === 0) continue;
    if (!looksLikeTask(title)) continue;
    items.push(title);
  }
  return items;
}

/**
 * Reject rows that parse as bullets but aren't actionable tasks:
 *   - Empty after stripping markdown emphasis
 *   - Trailing `:` (section header: "**M1 capstone (2026-04-19)**:")
 *   - Entire line is a bold run with nothing after
 *   - Starts with dependency prose markers ("depends on", "see also", "note:")
 */
function looksLikeTask(title: string): boolean {
  const stripped = title.replace(/\*+/g, '').trim();
  if (stripped.length === 0) return false;
  if (stripped.endsWith(':')) return false;
  if (/^(see also|note:)\b/i.test(stripped)) return false;
  // Dependency prose: "depends on X", "depend on Y", "all depend on Z" —
  // these describe relationships, not actionable work. Bullets that
  // legitimately describe a dependency-removal task tend to lead with an
  // imperative verb, so this filter rarely hits real tasks.
  if (/\b(all\s+)?depend(s|ed)?\s+on\b/i.test(stripped)) return false;
  // Bare bold header like `**Heading**` or `**M1**` — after stripping *s
  // it would still read as a heading because the *original* had no text
  // outside the bold run.
  if (/^\*\*[^*]+\*\*\s*$/.test(title.trim())) return false;
  return true;
}

/**
 * Extract the numeric portion of an ICE token (e.g. "ICE 100", "ICE-108",
 * "ice #120"). Returns null when absent — used to dedupe ROADMAP vs
 * BACKLOG entries that describe the same ICE.
 */
function extractIce(title: string): number | null {
  const match = /\bICE[\s#-]*(\d+)\b/i.exec(title);
  if (match?.[1] === undefined) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract the first `M<n>` token from a title (case-insensitive). Used
 * to pin tasks to an inferred milestone when the enclosing heading
 * omits one.
 */
function extractMilestoneRef(title: string): string | null {
  const match = /\b(M\d+)\b/i.exec(title);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Ensure a milestone row exists for `id`. Creates a planned placeholder
 * when the id was referenced but never declared; bumps the summary
 * counter so it surfaces in the import report. Returns the id as-is,
 * or null when `id` itself was null.
 */
function ensureMilestone(
  store: ScrumStore,
  id: string | null,
  declared: Set<string>,
  summary: ImportSummary,
): string | null {
  if (id === null) return null;
  if (declared.has(id)) return id;
  store.createMilestone({ id, title: id.toUpperCase(), status: 'planned' });
  declared.add(id);
  summary.milestones += 1;
  return id;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function slugifyWithIndex(prefix: string, text: string, idx: number): string {
  const base = slugify(text);
  return base.length > 0 ? `${prefix}-${base}-${idx}` : `${prefix}-${idx}`;
}
