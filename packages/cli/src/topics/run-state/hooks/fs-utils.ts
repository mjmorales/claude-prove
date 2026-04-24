/**
 * Shared filesystem helpers for run-state hooks.
 *
 * Both `session-start` and `stop` walk `<runs_root>/<branch>/<slug>/state.json`
 * to surface or reconcile active runs. This module hosts the two predicates
 * they both need — state.json parse and directory probe — so the traversal
 * logic in each hook reads as business logic, not IO plumbing.
 */

import { readFileSync, statSync } from 'node:fs';

/** Parse `state.json` as an object; return null on any read/parse error or
 *  non-object payload. Callers type-guard individual fields downstream. */
export function readStateJson(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** `true` iff `path` exists and is a directory. Swallows stat errors. */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
