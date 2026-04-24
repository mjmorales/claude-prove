/**
 * Shared filesystem helpers for run-state CLI commands.
 *
 * Extracted from `ls-cmd.ts` / `show-cmd.ts` so both iterate the runs tree
 * with identical semantics:
 *  - `sortedChildren`: readdir with graceful empty fallback on ENOENT/EPERM,
 *    sorted lexicographically for deterministic output.
 *  - `statSafe`: stat() wrapper that returns null on failure instead of
 *    throwing, letting callers skip unreadable entries without a try/catch.
 */

import { readdirSync, statSync } from 'node:fs';

/** Sorted directory listing; empty array if the directory is missing or unreadable. */
export function sortedChildren(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** `statSync` that swallows errors and returns null — caller inspects the result. */
export function statSafe(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
