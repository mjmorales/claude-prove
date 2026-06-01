/**
 * Stage-1 mechanical preservation validator for the Review Brief.
 *
 * Proves a rendered brief preserves every attention-bearing item from the
 * source reasoning log: each `hack`, `risk`, `bailout`, open `assumption`, and
 * every `decision`'s `alternatives`. This is the whole reason the brief is
 * trustworthy rather than advisory — without it a synthesizer could quietly
 * drop a risk while polishing prose.
 *
 * MECHANICAL only (no LLM, no judgment): it checks that each required item's
 * stable token survives into the brief text. `renderBrief` embeds each entry's
 * id and renders decision alternatives verbatim, so a present id (and, for
 * decisions, each alternative substring) is proof the item was carried through.
 * The Stage-2 prose-quality judge is non-blocking and lives in the skill.
 */

import type { LogEntry } from './reasoning-log';

export interface PreservationResult {
  ok: boolean;
  /** Human-readable ref per dropped item (`<kind>:<id>` / `decision-alternative:<id>:"…"`). Empty when ok. */
  missing: string[];
  /** Number of attention-bearing entries the brief was required to preserve. */
  required: number;
}

/**
 * Check `briefText` against the run's `entries`. An entry is required when it
 * is a `hack`/`risk`/`bailout`, an UNRESOLVED `assumption`, or a `decision`
 * carrying alternatives. For a decision, both the id and every alternative
 * string must appear. Returns `ok: false` plus the flat `missing` list on any
 * drop — the CLI maps that to exit 1 + the list on stderr.
 */
export function validatePreservation(briefText: string, entries: LogEntry[]): PreservationResult {
  const missing: string[] = [];
  let required = 0;

  for (const e of entries) {
    if (e.type === 'hack' || e.type === 'risk' || e.type === 'bailout') {
      required++;
      if (!briefText.includes(e.id)) missing.push(`${e.type}:${e.id}`);
    } else if (e.type === 'assumption' && !e.resolved) {
      required++;
      if (!briefText.includes(e.id)) missing.push(`open-assumption:${e.id}`);
    } else if (e.type === 'decision' && e.alternatives.length > 0) {
      required++;
      if (!briefText.includes(e.id)) missing.push(`decision:${e.id}`);
      for (const alt of e.alternatives) {
        if (!briefText.includes(alt)) missing.push(`decision-alternative:${e.id}:"${alt}"`);
      }
    }
  }

  return { ok: missing.length === 0, missing, required };
}
