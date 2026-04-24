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

  const roadmapPath = join(planningDir, 'ROADMAP.md');
  if (existsSync(roadmapPath)) {
    const roadmap = parseRoadmap(readFileSync(roadmapPath, 'utf8'));
    for (const milestone of roadmap.milestones) {
      store.createMilestone({ id: milestone.id, title: milestone.title, status: 'planned' });
      summary.milestones += 1;
    }
    for (const task of roadmap.tasks) {
      store.createTask({
        id: task.id,
        title: task.title,
        milestoneId: task.milestoneId,
        status: 'backlog',
      });
      summary.tasks += 1;
    }
    summary.deletedFiles.push('planning/ROADMAP.md');
  }

  const backlogPath = join(planningDir, 'BACKLOG.md');
  if (existsSync(backlogPath)) {
    const items = parseBulletList(readFileSync(backlogPath, 'utf8'));
    for (const [idx, title] of items.entries()) {
      const id = slugifyWithIndex('backlog', title, idx);
      store.createTask({ id, title, status: 'backlog' });
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
 * Recognizes `## Milestone: <Title>` headings as milestones and
 * `- [ ] <task title>` / `- <task title>` bullets under each heading as
 * tasks belonging to that milestone. Tasks before any milestone heading
 * land without a milestone.
 */
function parseRoadmap(content: string): {
  milestones: Array<{ id: string; title: string }>;
  tasks: Array<{ id: string; title: string; milestoneId: string | null }>;
} {
  const milestones: Array<{ id: string; title: string }> = [];
  const tasks: Array<{ id: string; title: string; milestoneId: string | null }> = [];
  let currentMilestone: string | null = null;
  let taskIdx = 0;

  for (const line of content.split('\n')) {
    const milestoneMatch = /^##\s+Milestone:\s+(.+?)\s*$/i.exec(line);
    if (milestoneMatch) {
      const title = milestoneMatch[1];
      if (title === undefined) continue;
      const id = slugify(title);
      milestones.push({ id, title });
      currentMilestone = id;
      continue;
    }
    const taskMatch = /^\s*-\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    if (taskMatch) {
      const title = taskMatch[1];
      if (title === undefined || title.length === 0) continue;
      const id = slugifyWithIndex('roadmap', title, taskIdx);
      tasks.push({ id, title, milestoneId: currentMilestone });
      taskIdx += 1;
    }
  }
  return { milestones, tasks };
}

/** Parse every `- <title>` bullet from markdown, in order. */
function parseBulletList(content: string): string[] {
  const items: string[] = [];
  for (const line of content.split('\n')) {
    const match = /^\s*-\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[1].length > 0) items.push(match[1]);
  }
  return items;
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
