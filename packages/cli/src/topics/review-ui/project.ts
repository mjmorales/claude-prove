/**
 * `claude-prove review-ui project <hide|remove|add|list> [path]` — manual
 * operator verbs over the machine-global project registry.
 *
 * The registry auto-populates as a side effect of git-root resolution; these
 * verbs are the explicit override surface:
 *
 *   hide   <path>  : mark the path's canonical root hidden (kept on disk, dropped from `list`)
 *   remove <path>  : delete the path's canonical root from the registry entirely
 *   add    <path>  : (re)register the path's canonical root, un-hiding any hidden entry
 *   list           : print visible projects as a JSON array, most-recently-seen first
 *
 * `list` prunes-on-read: dead entries (a vanished root or a missing
 * `.prove/prove.db`) are dropped before listing, so the surface never shows a
 * project the review UI could not open.
 *
 * `[path]` defaults to the current working directory for the mutating verbs.
 *
 * Output contract:
 *   - list           → JSON array of `{ path, name, last_seen }` on stdout.
 *   - hide/remove/add → a one-line human summary on stderr; nothing on stdout.
 *
 * Exit codes:
 *   0  success (including a no-op hide/remove on an unregistered path)
 *   1  usage error (unknown sub-action)
 *
 * The `baseOverride` option is the test seam — tests pass a tmp dir so they
 * never touch the developer's real `~/.claude-prove/projects.json`.
 */

import { add, hide, list, prune, remove } from '@claude-prove/store';

export const PROJECT_ACTIONS = ['hide', 'remove', 'add', 'list'] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export interface RunProjectOptions {
  /** Sub-action verb. An unrecognized value exits 1 with usage. */
  action: string;
  /** Target path for mutating verbs. Defaults to cwd when omitted. */
  path?: string;
  /** Registry base-dir override — the test seam. Real `~/.claude-prove/` when unset. */
  baseOverride?: string;
}

export function runProject(opts: RunProjectOptions): number {
  if (!isProjectAction(opts.action)) {
    // Summaries go to stderr (the stdout channel is the parseable `list` JSON).
    process.stderr.write(
      `claude-prove review-ui project: unknown sub-action '${opts.action}'. expected one of: ${PROJECT_ACTIONS.join(
        ', ',
      )}\n`,
    );
    return 1;
  }

  switch (opts.action) {
    case 'list':
      return runList(opts.baseOverride);
    case 'hide':
      return runHide(targetPath(opts.path), opts.baseOverride);
    case 'remove':
      return runRemove(targetPath(opts.path), opts.baseOverride);
    case 'add':
      return runAdd(targetPath(opts.path), opts.baseOverride);
  }
}

function isProjectAction(value: string): value is ProjectAction {
  return (PROJECT_ACTIONS as readonly string[]).includes(value);
}

/** Prune-on-read: drop dead roots before listing so the UI never sees them. */
function runList(baseOverride?: string): number {
  prune(baseOverride);
  const projects = list(baseOverride).map((p) => ({
    path: p.path,
    name: p.name,
    last_seen: p.last_seen,
  }));
  process.stdout.write(`${JSON.stringify(projects)}\n`);
  return 0;
}

function runHide(path: string, baseOverride?: string): number {
  const changed = hide(path, baseOverride);
  process.stderr.write(changed ? `hid ${path}\n` : `not registered: ${path}\n`);
  return 0;
}

function runRemove(path: string, baseOverride?: string): number {
  const changed = remove(path, baseOverride);
  process.stderr.write(changed ? `removed ${path}\n` : `not registered: ${path}\n`);
  return 0;
}

function runAdd(path: string, baseOverride?: string): number {
  const entry = add(path, baseOverride);
  process.stderr.write(`added ${entry.path}\n`);
  return 0;
}

function targetPath(path?: string): string {
  return path && path.length > 0 ? path : process.cwd();
}
