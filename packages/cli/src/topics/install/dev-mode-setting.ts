/**
 * Read the explicit `.claude/.prove.json::dev_mode` setting for a project.
 *
 * Tri-state result:
 *   - `true` / `false` — the config carries an explicit boolean `dev_mode`.
 *   - `undefined`      — config absent, unparseable, or `dev_mode` missing /
 *                        non-boolean.
 *
 * Hook codegen (`install init`, `install init-hooks`) treats the config as
 * the authority and falls back to filesystem detection (`detectMode`) ONLY
 * in the `undefined` case — an explicit `dev_mode: false` must always emit
 * the bare `claude-prove` invocation, no matter what the plugin dir looks
 * like. This mirrors the runtime emitters (`readDevMode` in the ACB hook,
 * the CLAUDE.md composer), which already route their invocation prefix
 * through the same field; those default the missing case to `false`, while
 * scaffolding keeps it tri-state so detection can still seed a fresh setup.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readDevModeSetting(projectRoot: string): boolean | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(projectRoot, '.claude', '.prove.json'), 'utf8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const value = (parsed as Record<string, unknown>).dev_mode;
  return typeof value === 'boolean' ? value : undefined;
}
