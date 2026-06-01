/**
 * Core logic for the `handoff` topic — deterministic session-handoff context.
 *
 * Emits deterministic session-handoff markdown — the sections State / Files
 * Modified / Recent Commits / Prove Artifacts / Discovery / Task Plan Steps:
 *   - composes Discovery and Task-Plan-Steps in-process via `composeSubagentContext`
 *     and `renderState` (no re-shelling `claude-prove`);
 *   - handles a repo with no `main`/`master` branch (no merge-base);
 *   - runs every git call through `spawnSync` arg-arrays (no shell).
 *
 * `gatherContext` is pure (returns markdown). `runGather` adds the stale-file
 * cleanup side effect and writes to stdout.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { composeSubagentContext } from '../claude-md/composer';
import { scanProject } from '../claude-md/scanner';
import { renderState } from '../run-state/render';

export interface GatherOpts {
  projectRoot: string;
  pluginDir?: string;
}

/** Run `git -C <root> <args>`; trimmed stdout, or `null` on any failure. */
function g(root: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? '').toString().trim();
  return out.length > 0 ? out : null;
}

function branchExists(root: string, branch: string): boolean {
  return (
    spawnSync('git', ['-C', root, 'rev-parse', '--verify', branch], { encoding: 'utf8' }).status ===
    0
  );
}

function bullets(paths: string[]): string {
  return paths.map((p) => `- \`${p}\``).join('\n');
}

export function gatherContext(opts: GatherOpts): string {
  const root = opts.projectRoot;
  const out: string[] = [];

  // --- Git state ---
  const branch = g(root, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown';
  const lastCommit = g(root, ['log', '-1', '--format=%h — %s']) ?? 'none';
  const mainBranch = branchExists(root, 'main')
    ? 'main'
    : branchExists(root, 'master')
      ? 'master'
      : null;
  const mergeBase = mainBranch ? g(root, ['merge-base', mainBranch, 'HEAD']) : null;

  const recentCommits = mergeBase
    ? g(root, ['log', '--oneline', `${mergeBase}..HEAD`])
    : g(root, ['log', '--oneline', '-5']);
  const diffStat = mainBranch
    ? lastLine(g(root, ['diff', '--stat', `${mainBranch}...HEAD`]))
    : null;

  out.push('## State');
  out.push('');
  out.push(`- **Branch**: \`${branch}\``);
  out.push(`- **Last commit**: ${lastCommit}`);
  if (diffStat) out.push(`- **Changes from ${mainBranch}**: ${diffStat}`);
  out.push('');

  // --- Files modified ---
  out.push('## Files Modified');
  out.push('');
  const staged = splitLines(g(root, ['diff', '--cached', '--name-only']));
  const unstaged = splitLines(g(root, ['diff', '--name-only']));
  if (staged.length > 0 || unstaged.length > 0) {
    if (staged.length > 0) {
      out.push('**Staged:**', bullets(staged.slice(0, 30)), '');
    }
    if (unstaged.length > 0) {
      out.push('**Unstaged:**', bullets(unstaged.slice(0, 30)), '');
    }
  } else {
    out.push('No uncommitted changes.', '');
    const branchFiles = mergeBase
      ? splitLines(g(root, ['diff', '--name-only', `${mergeBase}..HEAD`]))
      : [];
    if (branchFiles.length > 0) {
      out.push('**Changed on this branch:**', bullets(branchFiles.slice(0, 50)), '');
    }
  }

  // --- Recent commits ---
  if (recentCommits) {
    out.push('## Recent Commits', '', '```', recentCommits, '```', '');
  }

  // --- Prove artifacts ---
  out.push('## Prove Artifacts', '');
  out.push(...proveArtifacts(root));
  out.push('');

  // --- Discovery (in-process; no self-shelling) ---
  if (opts.pluginDir && opts.pluginDir.length > 0) {
    try {
      const discovery = composeSubagentContext(scanProject(root, opts.pluginDir), opts.pluginDir);
      if (discovery.trim().length > 0) {
        out.push('## Discovery', '', discovery.trimEnd(), '');
      }
    } catch {
      /* discovery is best-effort; omit on failure */
    }
  }

  // --- Task plan steps (one per active run's state.json) ---
  for (const { branch: runBranch, slug, statePath } of runStates(root)) {
    out.push(`## Task Plan Steps (${runBranch}/${slug})`, '');
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as Parameters<
        typeof renderState
      >[0];
      out.push(renderState(state).trimEnd(), '');
    } catch {
      /* skip unreadable/invalid state */
    }
  }

  return `${out.join('\n')}\n`;
}

/** Side-effecting entry: clear the stale handoff file, then print the context. */
export function runGather(opts: GatherOpts): number {
  const stale = join(opts.projectRoot, '.prove', 'handoff.md');
  if (existsSync(stale)) {
    // Best-effort cleanup: a read-only mount, permission error, or TOCTOU race
    // must not block emitting context. Degrade to a warning.
    try {
      rmSync(stale);
      process.stderr.write('handoff gather: cleaned stale .prove/handoff.md\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`handoff gather: could not remove stale .prove/handoff.md: ${msg}\n`);
    }
  }
  process.stdout.write(gatherContext(opts));
  return 0;
}

/** Markdown bullet list of discovered prove artifacts (or a git-only note). */
function proveArtifacts(root: string): string[] {
  const lines: string[] = [];
  const runsDir = join(root, '.prove', 'runs');
  if (existsSync(runsDir)) {
    for (const branch of subdirs(runsDir)) {
      for (const slug of subdirs(join(runsDir, branch))) {
        lines.push(`- \`.prove/runs/${branch}/${slug}/\` — orchestrator run state`);
      }
    }
  }
  const dirNote = (rel: string, note: string) => {
    if (existsSync(join(root, rel))) lines.push(`- \`${rel}\` — ${note}`);
  };
  dirNote('.prove/decisions/', 'decision records');
  dirNote('.prove/context/', 'handoff context from orchestrator');
  dirNote('.prove/reports/', 'orchestrator run reports');
  if (lines.length === 0) return ['No prove artifacts found. Context is git-only.'];
  return lines;
}

interface RunState {
  branch: string;
  slug: string;
  statePath: string;
}

/** Every `.prove/runs/<branch>/<slug>/state.json` on disk. */
function runStates(root: string): RunState[] {
  const runsDir = join(root, '.prove', 'runs');
  if (!existsSync(runsDir)) return [];
  const found: RunState[] = [];
  for (const branch of subdirs(runsDir)) {
    for (const slug of subdirs(join(runsDir, branch))) {
      const statePath = join(runsDir, branch, slug, 'state.json');
      if (existsSync(statePath)) found.push({ branch, slug, statePath });
    }
  }
  return found;
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function splitLines(value: string | null): string[] {
  return value
    ? value
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
}

function lastLine(value: string | null): string | null {
  const parts = splitLines(value);
  const last = parts.at(-1);
  return last ?? null;
}
