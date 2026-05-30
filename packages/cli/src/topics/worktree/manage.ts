/**
 * Core logic for the `worktree` topic — namespaced sub-task git worktrees.
 *
 * Hardened replacement for the former `manage-worktree.sh` script:
 *   - All git runs through `spawnSync('git', [...args])` with explicit arg
 *     arrays — no shell, so a slug/task-id can never inject flags or commands.
 *   - Slug/task-id are validated against a safe charset (no whitespace, no
 *     path-traversal) before they reach a path or a branch ref.
 *   - The main worktree root resolves via `mainWorktreeRoot()` rather than the
 *     fragile `git worktree list | head | sed` the script used.
 *   - Distinct exit codes separate usage errors (1) from git failures (2).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';

export const WORKTREE_ACTIONS = [
  'create',
  'remove',
  'remove-all',
  'list',
  'path',
  'branch',
  'reset',
] as const;
export type WorktreeAction = (typeof WORKTREE_ACTIONS)[number];

export interface WorktreeOpts {
  action: WorktreeAction;
  slug?: string;
  taskId?: string;
  base?: string;
  workspaceRoot?: string;
}

const USAGE = 1;
const GIT_FAIL = 2;

// Safe charset for slugs and task-ids: alphanumerics plus dot/dash/underscore.
// Excludes whitespace, slashes, and shell metacharacters; `..` is rejected
// separately so a value can never escape the worktrees directory or forge a ref.
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return {
    code: r.status ?? 1,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString(),
  };
}

function gitOk(cwd: string, args: string[]): boolean {
  return git(cwd, args).code === 0;
}

function valid(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && SAFE.test(value) && !value.includes('..');
}

export function runWorktree(opts: WorktreeOpts): number {
  const { action } = opts;

  if (!valid(opts.slug)) {
    process.stderr.write(`worktree ${action}: <slug> required (safe charset, no '..')\n`);
    return USAGE;
  }
  const slug = opts.slug;

  // remove-all and list operate on a slug only; the rest need a task-id.
  const needsTask = action !== 'remove-all' && action !== 'list';
  if (needsTask && !valid(opts.taskId)) {
    process.stderr.write(`worktree ${action}: <task-id> required (safe charset, no '..')\n`);
    return USAGE;
  }
  const taskId = opts.taskId;

  const root =
    opts.workspaceRoot && opts.workspaceRoot.length > 0
      ? opts.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const worktreeDir = join(root, '.claude', 'worktrees');
  const wtPath = taskId ? join(worktreeDir, `${slug}-task-${taskId}`) : '';
  const branch = taskId ? `task/${slug}/${taskId}` : '';
  const base = opts.base && opts.base.length > 0 ? opts.base : `orchestrator/${slug}`;

  switch (action) {
    case 'path':
      process.stdout.write(`${wtPath}\n`);
      return 0;

    case 'branch':
      process.stdout.write(`${branch}\n`);
      return 0;

    case 'list':
      return doList(worktreeDir, slug);

    case 'create':
      return doCreate(root, wtPath, branch, base, slug);

    case 'reset':
      return doReset(root, wtPath, base);

    case 'remove':
      return doRemove(root, wtPath, branch);

    case 'remove-all':
      return doRemoveAll(root, worktreeDir, slug);
  }
}

function doCreate(
  root: string,
  wtPath: string,
  branch: string,
  base: string,
  slug: string,
): number {
  if (!gitOk(root, ['rev-parse', '--verify', base])) {
    process.stderr.write(
      `worktree create: base branch '${base}' does not exist; create the orchestrator worktree first\n`,
    );
    return USAGE;
  }

  // Idempotent: existing worktree → refresh the slug marker and return its path.
  if (existsSync(wtPath)) {
    writeMarker(wtPath, slug);
    process.stdout.write(`${wtPath}\n`);
    process.stderr.write(`worktree create: ${wtPath} (exists)\n`);
    return 0;
  }

  // Path is gone — drop any stale registration, then a stale branch of the same name.
  git(root, ['worktree', 'prune']);
  if (gitOk(root, ['rev-parse', '--verify', branch])) {
    git(root, ['branch', '-D', branch]);
  }

  const add = git(root, ['worktree', 'add', wtPath, '-b', branch, base]);
  if (add.code !== 0) {
    process.stderr.write(`worktree create: git worktree add failed: ${add.stderr.trim()}\n`);
    return GIT_FAIL;
  }
  writeMarker(wtPath, slug);
  process.stdout.write(`${wtPath}\n`);
  process.stderr.write(`worktree create: ${wtPath} (created, branch ${branch} from ${base})\n`);
  return 0;
}

function doReset(root: string, wtPath: string, base: string): number {
  if (!existsSync(wtPath)) {
    process.stderr.write(`worktree reset: '${wtPath}' does not exist; create it first\n`);
    return USAGE;
  }
  if (!gitOk(root, ['rev-parse', '--verify', base])) {
    process.stderr.write(`worktree reset: base branch '${base}' does not exist\n`);
    return USAGE;
  }
  const reset = git(wtPath, ['reset', '--hard', base]);
  if (reset.code !== 0) {
    process.stderr.write(`worktree reset: git reset failed: ${reset.stderr.trim()}\n`);
    return GIT_FAIL;
  }
  git(wtPath, ['clean', '-fd']);
  process.stdout.write(`${wtPath}\n`);
  process.stderr.write(`worktree reset: ${wtPath} -> ${base}\n`);
  return 0;
}

function doRemove(root: string, wtPath: string, branch: string): number {
  if (existsSync(wtPath)) {
    if (git(root, ['worktree', 'remove', wtPath, '--force']).code !== 0) {
      rmSync(wtPath, { recursive: true, force: true });
    }
  }
  git(root, ['worktree', 'prune']);
  git(root, ['branch', '-D', branch]); // best-effort; ignore "not found"
  process.stderr.write(`worktree remove: ${wtPath}\n`);
  return 0;
}

function doRemoveAll(root: string, worktreeDir: string, slug: string): number {
  let count = 0;
  for (const path of taskWorktrees(worktreeDir, slug)) {
    if (git(root, ['worktree', 'remove', path, '--force']).code !== 0) {
      rmSync(path, { recursive: true, force: true });
    }
    count++;
  }
  git(root, ['worktree', 'prune']);
  const refs = git(root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/task/${slug}/`]);
  for (const ref of refs.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    git(root, ['branch', '-D', ref]);
  }
  process.stderr.write(`worktree remove-all: removed ${count} worktree(s) for ${slug}\n`);
  return 0;
}

function doList(worktreeDir: string, slug: string): number {
  const rows = taskWorktrees(worktreeDir, slug).map((path) => {
    const taskId = path.slice(join(worktreeDir, `${slug}-task-`).length);
    return { task_id: taskId, path, branch: `task/${slug}/${taskId}` };
  });
  process.stdout.write(`${JSON.stringify(rows)}\n`);
  process.stderr.write(`worktree list: ${rows.length} worktree(s) for ${slug}\n`);
  return 0;
}

/** Absolute paths of every `<slug>-task-*` worktree directory, sorted. */
function taskWorktrees(worktreeDir: string, slug: string): string[] {
  if (!existsSync(worktreeDir)) return [];
  const prefix = `${slug}-task-`;
  return readdirSync(worktreeDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => join(worktreeDir, e.name))
    .sort();
}

function writeMarker(wtPath: string, slug: string): void {
  writeFileSync(join(wtPath, '.prove-wt-slug.txt'), `${slug}\n`);
}
