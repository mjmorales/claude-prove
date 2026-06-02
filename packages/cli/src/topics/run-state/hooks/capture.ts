/**
 * PostToolUse capture hook — mechanical what-happened record into the active
 * run's reasoning log.
 *
 * Matcher `*` (all tools): after a tool call lands, this hook appends ONE
 * `capture` entry to the active run's reasoning log summarizing the *what* —
 * the tool name plus its edited/read/run target (`Write packages/x.ts`,
 * `Bash <cmd>`, `Read <path>`). Agents are then free to author only the
 * *why* as `decision`/`discovery`/etc. entries. The capture feeds episode
 * derivation and the Brief's files-changed / diff sections.
 *
 * Append-only and NEVER blocking. The hook always exits 0 and emits nothing
 * on stdout/stderr (no `permissionDecision`, no `systemMessage`): no active
 * run, an append failure, an unparseable payload, a tool with no checkable
 * target, or any resolution failure all pass silently. A PostToolUse hook
 * fires after the tool has already run, so blocking would be meaningless; the
 * floor here is "never surface an error to the agent and never alter control
 * flow", which a guaranteed empty exit-0 result satisfies.
 *
 * Active-run resolution: the reasoning log lives under the active run dir
 * `<main-root>/.prove/runs/<branch>/<slug>/log/`. The main worktree root is
 * resolved via the git common dir (so a linked worktree still targets the
 * canonical `.prove/`), and the run slug via the shared run-slug resolver
 * (env marker → worktree marker → plan scan). The branch segment is found by
 * scanning the immediate branch dirs under `.prove/runs/` for one holding the
 * slug — matching how the subagent-stop hook locates a run from its slug.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mainWorktreeRoot, resolveRunSlug } from '@claude-prove/shared';
import type { CaptureEntry } from '../../acb/reasoning-log';
import { appendEntry } from '../../acb/reasoning-log-store';
import { EMPTY_HOOK_RESULT, type HookResult, readCwd, readToolName } from './types';

/**
 * The reasoning-log agent segment all mechanical captures bucket under
 * (`<run-dir>/log/capture/`). A fixed bucket keeps engine-written capture
 * records separate from agent-authored judgment entries, which live under
 * their real authoring agent's segment.
 */
const CAPTURE_AGENT = 'capture';

/** Tools whose `tool_input.file_path` is the captured target. */
const FILE_PATH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Read', 'NotebookEdit']);

/** Max characters of a captured target before truncation. Bash commands and
 *  long paths are clipped so a single capture body stays compact in the log. */
const MAX_TARGET_LEN = 500;

/**
 * Injectable seam for the capture hook. `resolveRunDir` returns the active
 * run directory (or null when none); `now`/`uuid` are injected so tests get
 * deterministic entry ids and timestamps. Production wires the on-disk
 * resolver and the system clock.
 */
export interface CaptureHookDeps {
  resolveRunDir: (cwd: string) => string | null;
  now: () => string;
  uuid: () => string;
}

/** Production dependency wiring. */
export const DEFAULT_CAPTURE_DEPS: CaptureHookDeps = {
  resolveRunDir: resolveActiveRunDir,
  now: () => new Date().toISOString(),
  uuid: () => randomUUID(),
};

/**
 * Append one `capture` entry for a PostToolUse payload. ALWAYS returns
 * `EMPTY_HOOK_RESULT` (exit 0, no stdout/stderr) — every failure mode is
 * swallowed so the hook can never block a tool call or surface an error.
 */
export function runCaptureHook(
  payload: Record<string, unknown> | null,
  deps: CaptureHookDeps = DEFAULT_CAPTURE_DEPS,
): HookResult {
  try {
    appendCapture(payload, deps);
  } catch {
    // Append failure, resolution failure, anything — pass silently. A
    // PostToolUse capture must never wall off or error a tool call.
  }
  return EMPTY_HOOK_RESULT;
}

/** Resolve the run dir and append the capture entry. Throws are caught by the
 *  caller; this keeps the happy path linear and exception-free to read. */
function appendCapture(payload: Record<string, unknown> | null, deps: CaptureHookDeps): void {
  if (!payload) return;

  const tool = readToolName(payload);
  if (!tool) return;

  const runDir = deps.resolveRunDir(readCwd(payload));
  if (!runDir) return;

  const target = extractTarget(tool, payload);
  const entry = buildCaptureEntry(tool, target, runDir, deps);
  appendEntry(runDir, entry);
}

/**
 * Extract the captured target for a tool, or undefined when the tool exposes
 * no single checkable target. File tools yield their `tool_input.file_path`;
 * `Bash` yields its (truncated) command; every other tool captures the tool
 * name alone with no target.
 */
function extractTarget(tool: string, payload: Record<string, unknown>): string | undefined {
  if (FILE_PATH_TOOLS.has(tool)) {
    const fp = readNestedString(payload, 'file_path') || readNestedString(payload, 'notebook_path');
    return fp ? truncate(fp) : undefined;
  }
  if (tool === 'Bash') {
    const cmd = readNestedString(payload, 'command');
    return cmd ? truncate(cmd) : undefined;
  }
  return undefined;
}

/** Build a fully-formed, schema-valid `capture` entry. The body is the
 *  human-readable one-line summary (`<Tool> <target>`); `target` is omitted
 *  when absent so the optional field stays absent rather than empty. */
function buildCaptureEntry(
  tool: string,
  target: string | undefined,
  runDir: string,
  deps: CaptureHookDeps,
): CaptureEntry {
  const summary = target ? `${tool} ${target}` : tool;
  const entry: CaptureEntry = {
    id: deps.uuid(),
    ts: deps.now(),
    type: 'capture',
    agent: CAPTURE_AGENT,
    run_path: runDir,
    body: summary,
    tool,
  };
  if (target !== undefined) entry.target = target;
  return entry;
}

/** Read a nested `tool_input.<key>` string, or '' when missing/non-string. */
function readNestedString(payload: Record<string, unknown>, key: string): string {
  const ti = payload.tool_input;
  if (!ti || typeof ti !== 'object') return '';
  const value = (ti as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/** Clip a target to `MAX_TARGET_LEN`, marking the cut with an ellipsis. */
function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_TARGET_LEN) return collapsed;
  return `${collapsed.slice(0, MAX_TARGET_LEN - 1)}…`;
}

// ---------------------------------------------------------------------------
// Active-run resolution (production wiring)
// ---------------------------------------------------------------------------

/**
 * Resolve the active run directory `<main-root>/.prove/runs/<branch>/<slug>/`,
 * or null when no run is active. The main worktree root is found via the git
 * common dir (canonical `.prove/` even from a linked worktree); the slug via
 * the shared run-slug resolver; the branch by scanning the immediate branch
 * dirs under `.prove/runs/` for one holding a `<slug>/state.json`.
 */
export function resolveActiveRunDir(cwd: string): string | null {
  const slug = resolveRunSlug(cwd || undefined);
  if (!slug) return null;

  const mainRoot = mainWorktreeRoot(cwd || undefined) ?? (cwd || process.cwd());
  const runsRoot = join(mainRoot, '.prove', 'runs');
  if (!existsSync(runsRoot)) return null;

  let branches: string[];
  try {
    branches = readdirSync(runsRoot);
  } catch {
    return null;
  }

  for (const branch of branches) {
    const runDir = resolve(runsRoot, branch, slug);
    if (existsSync(join(runDir, 'state.json'))) return runDir;
  }
  return null;
}
