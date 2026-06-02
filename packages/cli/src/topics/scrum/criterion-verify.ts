/**
 * Write-isolated verification harness for `bash`/`agent` acceptance criteria.
 *
 * An `assert` criterion is decided in-process by the closed expression grammar
 * (see `assert-grammar.ts`). The other executable kind — `bash` — runs a real
 * shell command, and that command must never be allowed to touch the real
 * working tree: a verification check that mutates the tree it is checking
 * corrupts the very state the engine relies on, and concurrent checks sharing
 * one tree would race. This module runs each `bash` criterion inside a
 * dedicated short-lived git worktree cut from the story's HEAD commit, so the
 * check is write-isolated by construction:
 *
 *   - tool surface is Bash-only — the check is exactly the criterion's `check`
 *     string handed to a shell, nothing else;
 *   - the only writable path is the throwaway worktree, never the real tree, so
 *     any write the check performs is discarded when the worktree is removed —
 *     `bounds.write` is CLOSED by the worktree wall, not by a permission rule;
 *   - a wall-clock timeout bounds the run (the criterion's `timeout` if set,
 *     else a sane default) — a hung check is killed, never awaited forever;
 *   - on failure the captured stdout/stderr is persisted to a run-dir file for
 *     inspection; a passing check leaves no artifact;
 *   - the worktree is removed in a `finally`, pass or fail (even when the check
 *     throws), so nothing leaks.
 *
 * Because each criterion gets its own worktree cut from the same commit, two
 * criteria verifying in parallel cannot collide — a write in one is invisible
 * to the other and to the real tree. That isolation is what makes parallel
 * acceptance evaluation safe.
 *
 * # `agent`-kind criteria share the same isolation
 *
 * An `agent` criterion is judged by a model (the validation-agent), not by a
 * shell, so the engine cannot run it here — the model invocation stays
 * driver-side. What the engine CAN do, and does, is hand the agent the same
 * read-only surface: `prepareAgentWorktree` cuts the identical short-lived
 * worktree from story HEAD and returns its path, the driver points the agent at
 * that path as its working directory, and the caller removes the worktree when
 * the agent verdict is in. The agent therefore reads exactly the isolated tree
 * a `bash` check would, with the same write-isolation guarantee.
 *
 * # Engine/model boundary
 *
 * Worktree lifecycle, shell exec, timeout, capture, and cleanup are mechanical
 * — they live here in the CLI. The runner and clock are injected so the harness
 * is deterministic under test; production wiring uses the real Bun spawn runner
 * and `Date.now`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type EphemeralWorktree,
  createEphemeralWorktree,
  removeEphemeralWorktree,
} from '../worktree/manage';
import type { AcceptanceCriterion } from './types';

// ---------------------------------------------------------------------------
// Timeout parsing
// ---------------------------------------------------------------------------

/**
 * Default wall-clock budget for a `bash` criterion with no explicit `timeout`.
 * A check is expected to be a focused gate (a build, a test run, a grep), not a
 * long job; this ceiling kills a hung check while leaving ample room for a
 * normal one.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Parse a criterion's free-form `timeout` string into milliseconds. Accepts a
 * bare number (seconds), or a number with an `s`/`m`/`h` suffix. An absent,
 * empty, or unparseable value falls back to `DEFAULT_TIMEOUT_MS` rather than
 * throwing — a malformed budget should not block verification, only lose its
 * custom ceiling.
 */
export function parseTimeoutMs(timeout: string | undefined): number {
  if (!timeout) return DEFAULT_TIMEOUT_MS;
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(timeout.trim());
  if (!match) return DEFAULT_TIMEOUT_MS;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  const unit = (match[2] ?? 's').toLowerCase();
  const factorMs = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000;
  return Math.round(value * factorMs);
}

// ---------------------------------------------------------------------------
// Injected shell runner
// ---------------------------------------------------------------------------

/**
 * Outcome of running one shell check. `timedOut` is true when the wall-clock
 * budget killed the process before it exited; `exitCode` is the process exit
 * code (0 = pass) and is meaningless when `timedOut` is true.
 */
export interface ShellRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs `command` as a shell, in `cwd`, killed after `timeoutMs`. Injected so a
 * test can substitute a deterministic stub; production uses `realShellRunner`.
 */
export type ShellRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<ShellRunResult>;

/**
 * Production runner: spawn the check as a Bash command in the isolated
 * worktree, capped by Bun's `timeout`. A timeout kills the process with
 * SIGKILL; we detect that via `signalCode` rather than trusting the exit code,
 * because a killed process reports a synthetic non-zero code that is
 * indistinguishable from a legitimate failure.
 */
export const realShellRunner: ShellRunner = async (command, cwd, timeoutMs) => {
  const proc = Bun.spawn({
    cmd: ['bash', '-c', command],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const timedOut = proc.signalCode === 'SIGKILL';
  return { exitCode, stdout, stderr, timedOut };
};

// ---------------------------------------------------------------------------
// Verification options + result
// ---------------------------------------------------------------------------

/**
 * Inputs for verifying one `bash` criterion in isolation.
 *
 *   repoRoot   — any path inside the repository; the worktree is cut relative
 *                to it.
 *   storyHead  — the commit-ish the worktree is detached at (the story's HEAD).
 *   runDir     — directory under which a failure transcript is persisted
 *                (`<runDir>/criterion-verify/<criterion-id>.log`). Omit to skip
 *                persistence (the transcript is still returned in the result).
 *   runner     — injected shell runner; defaults to `realShellRunner`.
 */
export interface BashVerifyOptions {
  repoRoot: string;
  storyHead: string;
  runDir?: string;
  runner?: ShellRunner;
}

/**
 * Result of verifying one `bash` criterion.
 *
 *   ok          — true only when the check exited 0 and was not timed out.
 *   exitCode    — the shell exit code (meaningless when `timedOut`).
 *   timedOut    — true when the wall-clock budget killed the check.
 *   stdout      — captured standard output.
 *   stderr      — captured standard error.
 *   sha         — the commit the isolated worktree was cut from.
 *   transcriptPath — absolute path the failure transcript was written to, or
 *                    null on a pass or when `runDir` was omitted.
 */
export interface BashVerifyResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  sha: string;
  transcriptPath: string | null;
}

// ---------------------------------------------------------------------------
// Bash criterion verification
// ---------------------------------------------------------------------------

/**
 * Verify one `bash` acceptance criterion inside a dedicated short-lived
 * worktree cut from `storyHead`. The criterion's `check` runs as a Bash command
 * with the worktree as its working directory and the only writable surface, so
 * it cannot mutate the real tree. A wall-clock timeout (the criterion's
 * `timeout`, else `DEFAULT_TIMEOUT_MS`) kills a hung check. On failure the
 * stdout/stderr transcript is persisted under `runDir`. The worktree is removed
 * in a `finally`, pass or fail.
 *
 * Throws if the criterion is not `bash`-kind (an `assert` is decided
 * in-process; an `agent` is judged driver-side via `prepareAgentWorktree`).
 */
export async function verifyBashCriterion(
  criterion: AcceptanceCriterion,
  opts: BashVerifyOptions,
): Promise<BashVerifyResult> {
  if (criterion.verifies_by !== 'bash') {
    throw new Error(
      `verifyBashCriterion: expected a 'bash' criterion, got '${criterion.verifies_by}'`,
    );
  }
  const runner = opts.runner ?? realShellRunner;
  const timeoutMs = parseTimeoutMs(criterion.timeout);

  let worktree: EphemeralWorktree | null = null;
  try {
    worktree = createEphemeralWorktree(opts.repoRoot, opts.storyHead);
    const run = await runner(criterion.check, worktree.path, timeoutMs);
    const ok = run.exitCode === 0 && !run.timedOut;
    const transcriptPath = ok
      ? null
      : persistFailure(opts.runDir, criterion, opts.repoRoot, worktree.sha, run, timeoutMs);
    return {
      ok,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      stdout: run.stdout,
      stderr: run.stderr,
      sha: worktree.sha,
      transcriptPath,
    };
  } finally {
    if (worktree) removeEphemeralWorktree(opts.repoRoot, worktree.path);
  }
}

/**
 * Write a failure transcript for a criterion to
 * `<runDir>/criterion-verify/<criterion-id>.log` and return its absolute path.
 * Returns null when no `runDir` is given (persistence is opt-in; the transcript
 * still rides back in the result). Best-effort: a write failure returns null
 * rather than masking the verification failure that triggered it.
 */
function persistFailure(
  runDir: string | undefined,
  criterion: AcceptanceCriterion,
  repoRoot: string,
  sha: string,
  run: ShellRunResult,
  timeoutMs: number,
): string | null {
  if (!runDir) return null;
  const dir = join(runDir, 'criterion-verify');
  const file = join(dir, `${safeName(criterion.id)}.log`);
  const verdict = run.timedOut ? `TIMEOUT after ${timeoutMs}ms` : `FAIL (exit ${run.exitCode})`;
  const body = [
    `criterion: ${criterion.id}`,
    `text: ${criterion.text}`,
    `check: ${criterion.check}`,
    `worktree-sha: ${sha}`,
    `repo-root: ${repoRoot}`,
    `verdict: ${verdict}`,
    '',
    '--- stdout ---',
    run.stdout,
    '--- stderr ---',
    run.stderr,
    '',
  ].join('\n');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, body);
    return file;
  } catch {
    return null;
  }
}

/**
 * Sanitize a criterion id into a filesystem-safe basename. Criterion ids are
 * author-supplied, so any character outside the safe set collapses to `-`, and
 * any `.` run collapses to a single `-` too — that closes the `..` traversal
 * the dot would otherwise permit — keeping the transcript path inside `runDir`.
 */
function safeName(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]+/g, '-');
  return cleaned.length > 0 ? cleaned : 'criterion';
}

// ---------------------------------------------------------------------------
// Agent criterion isolation
// ---------------------------------------------------------------------------

/**
 * Result of preparing the isolated worktree an `agent` criterion is judged
 * against. The model invocation itself stays driver-side; this only supplies
 * the read-only surface and the teardown the driver must call afterward.
 */
export interface AgentWorktree {
  /** Working directory to point the validation-agent at. */
  path: string;
  /** The commit the worktree was cut from. */
  sha: string;
  /**
   * Idempotent teardown — call once the agent verdict is in (in a `finally`).
   * Removes the worktree so the agent's reads leave nothing behind.
   */
  cleanup: () => void;
}

/**
 * Cut the same short-lived worktree a `bash` check would get, for an `agent`
 * criterion to be judged against. Returns the worktree path plus a `cleanup`
 * the driver invokes once the agent verdict is recorded. The agent reads the
 * isolated tree and never the real one, so its judgment carries the identical
 * write-isolation guarantee — the engine just cannot run the model itself.
 *
 * Throws if the criterion is not `agent`-kind.
 */
export function prepareAgentWorktree(
  criterion: AcceptanceCriterion,
  repoRoot: string,
  storyHead: string,
): AgentWorktree {
  if (criterion.verifies_by !== 'agent') {
    throw new Error(
      `prepareAgentWorktree: expected an 'agent' criterion, got '${criterion.verifies_by}'`,
    );
  }
  const worktree = createEphemeralWorktree(repoRoot, storyHead);
  return {
    path: worktree.path,
    sha: worktree.sha,
    cleanup: () => removeEphemeralWorktree(repoRoot, worktree.path),
  };
}
