/**
 * Named model-config presets — curated `models` blocks optimized per
 * use case. A preset is pure expansion sugar: `models set --preset <name>`
 * seeds the block from this closed table (field flags override), then the
 * normal schema validation and `models apply` materialization path apply
 * unchanged. Adding a preset means editing this table — never a config file
 * — so the set stays closed and reviewable.
 *
 * Rationale per preset (the pairing economics these encode):
 *   - balanced   : `opusplan` switches Opus in at the plan boundary and
 *                  Sonnet for execution; the Opus advisor covers mid-task
 *                  decision points the plan boundary misses.
 *   - deep       : two Opus passes — an independent same-tier check for
 *                  work where correctness dominates cost. Deliberately no
 *                  fallback chain: on a high-stakes task a silent drop to a
 *                  weaker model is worse than a visible failure.
 *   - economy    : Sonnet handles routine work and escalates planning,
 *                  ambiguous failures, and completion checks to the Opus
 *                  advisor; medium effort trims reasoning cost on
 *                  straightforward turns.
 *   - unattended : for overnight/CI driving where nobody is watching —
 *                  the fallback chain keeps a night alive through
 *                  non-retryable server errors (forward progress beats
 *                  model purity when unattended), with the Opus advisor
 *                  guarding decision points.
 */

import type { ModelsBlock } from '@claude-prove/installer';

export interface ModelPreset {
  /** The full `models` block this preset expands to. */
  block: ModelsBlock;
  /** One-line use-case description shown by `models presets`. */
  use: string;
}

export const MODEL_PRESETS: Record<string, ModelPreset> = {
  balanced: {
    block: { main: 'opusplan', advisor: 'opus', effort: 'high' },
    use: 'daily driving — Opus plans, Sonnet executes, Opus advisor on mid-task decision points',
  },
  deep: {
    block: { main: 'opus', advisor: 'opus', effort: 'xhigh' },
    use: 'high-stakes work — a second Opus independently checks the first; no fallback, failures stay visible',
  },
  economy: {
    block: { main: 'sonnet', advisor: 'opus', effort: 'medium' },
    use: 'routine work at lower cost — Sonnet throughout, escalating planning and completion checks to Opus',
  },
  unattended: {
    block: {
      main: 'sonnet',
      advisor: 'opus',
      fallback: ['sonnet', 'haiku'],
      effort: 'high',
    },
    use: 'overnight/CI driving — fallback chain survives server errors when nobody is watching',
  },
};

export const PRESET_NAMES = Object.keys(MODEL_PRESETS);

/**
 * `claude-prove models presets` — list the closed preset table: name, the
 * block each expands to, and its use case. Read-only.
 */
export function runPresets(): number {
  for (const [name, preset] of Object.entries(MODEL_PRESETS)) {
    const b = preset.block;
    const fields = [
      b.main ? `main=${b.main}` : undefined,
      b.advisor ? `advisor=${b.advisor}` : undefined,
      b.fallback && b.fallback.length > 0 ? `fallback=${b.fallback.join(',')}` : undefined,
      b.effort ? `effort=${b.effort}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`  ${name.padEnd(11)} ${fields}`);
    console.log(`  ${''.padEnd(11)} ${preset.use}`);
  }
  console.log(
    'claude-prove models presets: declare one with `claude-prove models set --preset <name>` (field flags override)',
  );
  return 0;
}
