/**
 * Best-effort JSON file read for the orchestrator prompt renderers.
 */

import { readFileSync } from 'node:fs';

/**
 * Parse `path` as JSON, returning `null` on any failure (missing file,
 * unreadable, malformed JSON). Callers treat a missing artifact as "absent",
 * so a thrown error is never the right signal here.
 */
export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
