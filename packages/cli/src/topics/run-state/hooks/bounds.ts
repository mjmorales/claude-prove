/**
 * PreToolUse hook — enforces a task's declared read/write path globs as a hard
 * scope-check wall.
 *
 * A scrum task MAY declare `bounds` with `read[]` / `write[]` path globs
 * (project-root-relative, `**`-aware). Those globs are otherwise advisory: the
 * git worktree is the only structural write wall and nothing blocks a read or a
 * finer-grained write. This hook turns the declared globs into a native wall.
 *
 * On a `Write`/`Edit`/`MultiEdit` whose target path falls outside the declared
 * `write` globs (or a `Read` outside the declared `read` globs), or a `Bash`
 * command whose extracted write target falls outside the `write` globs, the
 * hook emits a `{decision: "block", reason}` payload and exits 2 — the Claude
 * Code PreToolUse block contract that feeds the reason back to the agent.
 *
 * Permissive by construction. The hook NEVER false-blocks: absent or empty
 * bounds, an ambiguous active task, a tool with no checkable target, or any
 * resolution failure all pass silently (exit 0). The wall fires only on a
 * clear, declared out-of-bounds access.
 *
 * Active-task resolution: the single `in_progress` scrum task that carries
 * authored bounds. Zero such tasks, or more than one, is ambiguous and passes.
 * The scrum store lives at the enclosing git repository's main worktree
 * (`<main-root>/.prove/prove.db`); in a linked worktree the payload `cwd` is
 * resolved to that main root via the git common directory.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { openScrumStore } from '../../scrum/store';
import type { TaskBounds } from '../../scrum/types';
import { pyJsonDump } from './json-compat';
import {
  EMPTY_HOOK_RESULT,
  type HookResult,
  readCwd,
  readFilePathField,
  readToolName,
} from './types';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const READ_TOOL = 'Read';
const BASH_TOOL = 'Bash';

/**
 * The active task's declared bounds plus the project root its globs are
 * relative to. `projectRoot` is the main git worktree root — every glob in
 * `read`/`write` is resolved against it.
 */
export interface ActiveBounds {
  bounds: TaskBounds;
  projectRoot: string;
}

/**
 * Injectable seam for the scope-check hook. `resolveActiveBounds` returns the
 * active task's bounds (or null when none/ambiguous); `now`-free by design.
 * Tests pass a stub; production wires `resolveActiveBoundsFromStore`.
 */
export interface BoundsHookDeps {
  resolveActiveBounds: (cwd: string) => ActiveBounds | null;
}

/** Production dependency wiring: resolve bounds from the on-disk scrum store. */
export const DEFAULT_BOUNDS_DEPS: BoundsHookDeps = {
  resolveActiveBounds: resolveActiveBoundsFromStore,
};

export function runBoundsHook(
  payload: Record<string, unknown> | null,
  deps: BoundsHookDeps = DEFAULT_BOUNDS_DEPS,
): HookResult {
  if (!payload) return EMPTY_HOOK_RESULT;

  const toolName = readToolName(payload);
  const isWrite = WRITE_TOOLS.has(toolName);
  const isRead = toolName === READ_TOOL;
  const isBash = toolName === BASH_TOOL;
  if (!isWrite && !isRead && !isBash) return EMPTY_HOOK_RESULT;

  const cwd = readCwd(payload);

  let active: ActiveBounds | null;
  try {
    active = deps.resolveActiveBounds(cwd);
  } catch {
    // Resolution failure (no git root, locked db, parse error) is permissive —
    // a broken lookup must never wall off an otherwise-valid tool call.
    return EMPTY_HOOK_RESULT;
  }
  if (!active) return EMPTY_HOOK_RESULT;

  const { bounds, projectRoot } = active;

  if (isRead) {
    return checkRead(payload, bounds, projectRoot);
  }
  if (isWrite) {
    return checkWrite(readFilePathField(payload), bounds, projectRoot);
  }
  return checkBash(payload, bounds, projectRoot);
}

/** A `Read` outside the declared `read` globs blocks; absent read globs pass. */
function checkRead(
  payload: Record<string, unknown>,
  bounds: TaskBounds,
  projectRoot: string,
): HookResult {
  const globs = bounds.read;
  if (!globs || globs.length === 0) return EMPTY_HOOK_RESULT;

  const filePath = readFilePathField(payload);
  if (!filePath) return EMPTY_HOOK_RESULT;

  const rel = toProjectRelative(filePath, projectRoot);
  if (rel === null || matchesAny(rel, globs)) return EMPTY_HOOK_RESULT;

  return block(scopeViolationReason('read', `Read of '${rel}'`, globs));
}

/** A write outside the declared `write` globs blocks; absent write globs pass. */
function checkWrite(filePath: string, bounds: TaskBounds, projectRoot: string): HookResult {
  const globs = bounds.write;
  if (!globs || globs.length === 0) return EMPTY_HOOK_RESULT;
  if (!filePath) return EMPTY_HOOK_RESULT;

  const rel = toProjectRelative(filePath, projectRoot);
  if (rel === null || matchesAny(rel, globs)) return EMPTY_HOOK_RESULT;

  return block(scopeViolationReason('write', `Write to '${rel}'`, globs));
}

/**
 * A `Bash` command whose extracted write target falls outside the declared
 * `write` globs blocks. Conservative: only clear in-repo write targets are
 * checked; absent write globs or no detectable target pass.
 */
function checkBash(
  payload: Record<string, unknown>,
  bounds: TaskBounds,
  projectRoot: string,
): HookResult {
  const globs = bounds.write;
  if (!globs || globs.length === 0) return EMPTY_HOOK_RESULT;

  const command = readBashCommand(payload);
  if (!command) return EMPTY_HOOK_RESULT;

  for (const target of extractBashWriteTargets(command)) {
    const rel = toProjectRelative(target, projectRoot);
    // Out-of-repo targets (rel === null) are not the bounds wall's concern.
    if (rel === null || matchesAny(rel, globs)) continue;
    return block(scopeViolationReason('write', `Bash command writes to '${rel}'`, globs));
  }
  return EMPTY_HOOK_RESULT;
}

/**
 * Build the block reason for a scope violation. `kind` selects the read/write
 * verb; `action` describes the attempted access; `globs` is the declared scope
 * the agent must stay inside or widen.
 */
function scopeViolationReason(kind: 'read' | 'write', action: string, globs: string[]): string {
  return `${action} is outside the active task's declared ${kind} scope (${globs.join(', ')}). Amend the task bounds (\`claude-prove scrum task bounds set\`) to widen the ${kind} scope, or target a path inside it.`;
}

/** Read the nested `tool_input.command` string for a `Bash` call. */
function readBashCommand(payload: Record<string, unknown>): string {
  const ti = payload.tool_input;
  if (!ti || typeof ti !== 'object') return '';
  const cmd = (ti as Record<string, unknown>).command;
  return typeof cmd === 'string' ? cmd : '';
}

/**
 * Heuristically extract the write target paths from a shell command. Covers the
 * two unambiguous in-repo write forms: output redirections (`> p`, `>> p`,
 * `2> p`) and the path argument of common mutating commands (`rm`, `mv`, `cp`,
 * `touch`, `mkdir`, `tee`, `dd of=…`). Deliberately conservative — anything not
 * a clear write target is omitted so the wall never fires on ambiguity.
 */
export function extractBashWriteTargets(command: string): string[] {
  const targets: string[] = [];

  // Redirections: `>`, `>>`, `N>`, `N>>` followed by a path token. The token
  // is a double-quoted string, a single-quoted string, or a bare run of
  // non-special chars. Skip `>&` (fd duplication) and process substitution
  // `>(...)`.
  const redirect = /(?:^|\s)\d*>>?\s*("[^"]*"|'[^']*'|[^\s&|;<>()]+)/g;
  for (const m of command.matchAll(redirect)) {
    const tok = stripQuotes(m[1] ?? '');
    if (tok) targets.push(tok);
  }

  // `dd of=<path>`.
  const ddOf = /\bof=([^\s&|;<>]+)/g;
  for (const m of command.matchAll(ddOf)) {
    const tok = stripQuotes(m[1] ?? '');
    if (tok) targets.push(tok);
  }

  // Mutating commands: the trailing positional path args (skip flags). For
  // `cp`/`mv` the destination is the last arg; for `rm`/`touch`/`mkdir`/`tee`
  // every positional arg is a write target. Split on `;`, `&&`, `||`, `|` so a
  // mutating command anywhere in a pipeline/chain is inspected.
  const MUTATORS = new Set(['rm', 'mv', 'cp', 'touch', 'mkdir', 'tee']);
  for (const segment of command.split(/\s*(?:&&|\|\||[;|])\s*/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const cmd = tokens[0];
    if (!cmd || !MUTATORS.has(cmd)) continue;
    const args = tokens.slice(1).filter((t) => !t.startsWith('-'));
    for (const arg of args) {
      const tok = stripQuotes(arg);
      if (tok) targets.push(tok);
    }
  }

  return targets;
}

/** Strip a single layer of matching single or double quotes from a token. */
function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/**
 * Resolve a tool target path to a project-root-relative POSIX path, or `null`
 * when it escapes the project root (outside the bounds wall's concern).
 * Relative inputs are resolved against `projectRoot`. Backslashes are
 * normalized to `/` so Windows-style payload paths compare against POSIX globs.
 */
export function toProjectRelative(target: string, projectRoot: string): string | null {
  const abs = isAbsolute(target) ? target : resolve(projectRoot, target);
  const rel = relative(projectRoot, abs).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('../') || rel === '..') return null;
  return rel;
}

/** True when `path` matches any glob in `globs`. */
export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globMatch(path, g));
}

/**
 * Match a project-relative POSIX path against a single glob. Supports `*`
 * (any run of non-`/` chars), `**` (any run including `/`), and `?` (one
 * non-`/` char). A trailing `/**` also matches the directory prefix itself
 * (e.g. `src/**` matches `src`), so a directory's own bounds entry covers it.
 */
export function globMatch(path: string, glob: string): boolean {
  const normGlob = glob.replace(/\\/g, '/');
  const re = globToRegExp(normGlob);
  if (re.test(path)) return true;
  // `dir/**` matches the bare `dir` as well as everything under it.
  if (normGlob.endsWith('/**')) {
    const prefix = normGlob.slice(0, -3);
    if (globToRegExp(prefix).test(path)) return true;
  }
  return false;
}

/** Compile a glob to a full-string-anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch !== undefined && '.+^${}()|[]\\'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += '$';
  return new RegExp(re);
}

/** Emit the PreToolUse block payload + exit 2. */
function block(reason: string): HookResult {
  const body = pyJsonDump({ decision: 'block', reason });
  return { exitCode: 2, stdout: body, stderr: '' };
}

// ---------------------------------------------------------------------------
// Active-task resolution (production wiring)
// ---------------------------------------------------------------------------

/**
 * Resolve the active task's bounds from the on-disk scrum store.
 *
 * The active task is the single `in_progress` scrum task carrying authored
 * bounds. Zero such tasks, or more than one (ambiguous), yields `null` — the
 * permissive path. The store path is the enclosing main worktree's
 * `<main-root>/.prove/prove.db`; a missing store yields `null`.
 */
export function resolveActiveBoundsFromStore(cwd: string): ActiveBounds | null {
  const projectRoot = mainWorktreeRoot(cwd);
  if (!projectRoot) return null;

  const dbPath = resolve(projectRoot, '.prove', 'prove.db');
  if (!existsSync(dbPath)) return null;

  // Open read-write (not readonly): a readonly handle cannot replay another
  // process's uncheckpointed WAL, so it would read stale state while a writer
  // session holds the latest committed rows in `prove.db-wal`. A RW handle sees
  // the live committed state. The hook only reads.
  const store = openScrumStore({ override: dbPath });
  try {
    const bounded = store
      .listTasks({ status: 'in_progress' })
      .filter((t) => t.bounds !== null && hasPathGlobs(t.bounds));
    if (bounded.length !== 1) return null;
    const bounds = bounded[0]?.bounds;
    if (!bounds) return null;
    return { bounds, projectRoot };
  } finally {
    store.close();
  }
}

/** True when the bounds declare at least one read or write path glob. */
function hasPathGlobs(bounds: TaskBounds): boolean {
  return (bounds.read?.length ?? 0) > 0 || (bounds.write?.length ?? 0) > 0;
}

/**
 * Resolve the main git worktree root from a starting directory by walking
 * upward for a `.git` entry — no `git` subprocess, so the hook stays fast and
 * has no spawn-failure surface.
 *
 * In the main worktree `.git` is a directory and its parent is the root. In a
 * linked worktree `.git` is a file whose `gitdir:` line points at
 * `<main-root>/.git/worktrees/<name>`; the main root is two levels above the
 * `worktrees/` segment. Either way the returned root is where the canonical
 * `.prove/prove.db` lives. Returns `null` when no `.git` is found.
 */
function mainWorktreeRoot(cwd: string): string | null {
  const start = cwd && cwd.length > 0 ? resolve(cwd) : process.cwd();

  let cur = start;
  while (true) {
    const gitPath = join(cur, '.git');
    if (existsSync(gitPath)) {
      return statSync(gitPath).isDirectory() ? cur : mainRootFromGitFile(gitPath);
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Parse a linked worktree's `.git` file (`gitdir: <path>/.git/worktrees/<name>`)
 * and return the main worktree root — the directory containing `.git`, i.e. the
 * grandparent of the `worktrees/<name>` tail. Returns `null` on an unparseable
 * file or an unexpected layout.
 */
function mainRootFromGitFile(gitFilePath: string): string | null {
  let content: string;
  try {
    content = readFileSync(gitFilePath, 'utf8');
  } catch {
    return null;
  }
  const match = content.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match || !match[1]) return null;

  const gitdir = match[1].trim();
  const absGitdir = isAbsolute(gitdir) ? gitdir : resolve(dirname(gitFilePath), gitdir);
  // `<root>/.git/worktrees/<name>`: dirname once → `<root>/.git/worktrees`,
  // twice → `<root>/.git`, thrice → `<root>`. Verify the expected segments
  // before trusting the layout.
  const worktreesDir = dirname(absGitdir);
  const gitDir = dirname(worktreesDir);
  if (basename(worktreesDir) === 'worktrees' && basename(gitDir) === '.git') {
    return dirname(gitDir);
  }
  return null;
}
