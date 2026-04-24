/**
 * Register the `prompting` topic on the cac instance.
 *
 * Landing for prompt-engineering helpers (currently just token-count,
 * with room for future additions like craft/cache). Mirrors the Python
 * entrypoint `scripts/token-count.py` so skills and docs flip from
 * `python3 scripts/token-count.py …` to `prove prompting token-count …`
 * without interface drift.
 *
 *   prove prompting token-count <patterns...> [--sort KEY] [--json] [--no-strip]
 *
 * Exit codes:
 *   0  success (including empty match sets — matches Python reference)
 *   1  unknown action / usage error
 */

import type { CAC } from 'cac';
import { type SortKey, runTokenCountCmd } from './prompting/token-count';

type PromptingAction = 'token-count';

const PROMPTING_ACTIONS: PromptingAction[] = ['token-count'];

const SORT_KEYS: readonly SortKey[] = ['tokens', 'name', 'lines'];

interface PromptingFlags {
  sort?: string;
  json?: boolean;
  // cac registers `--no-strip` as a negated flag under the key `strip`
  // with default=true. When the user passes `--no-strip`, cac sets
  // flags.strip to false; otherwise it stays true.
  strip?: boolean;
}

export function register(cli: CAC): void {
  cli
    .command('prompting <action> [...patterns]', 'Prompt engineering helpers (action: token-count)')
    .option('--sort <key>', 'Sort order: tokens | name | lines (default: tokens)')
    .option('--json', 'Machine-readable JSON output')
    .option('--no-strip', 'Include YAML frontmatter in counts (stripped by default)')
    .action((action: string, patterns: string[], flags: PromptingFlags) => {
      if (!isPromptingAction(action)) {
        console.error(
          `error: unknown prompting action '${action}'. expected one of: ${PROMPTING_ACTIONS.join(', ')}`,
        );
        process.exit(1);
      }
      const code = dispatch(action, patterns, flags);
      process.exit(code);
    });
}

function isPromptingAction(value: string): value is PromptingAction {
  return (PROMPTING_ACTIONS as string[]).includes(value);
}

function dispatch(action: PromptingAction, patterns: string[], flags: PromptingFlags): number {
  switch (action) {
    case 'token-count': {
      const sort = resolveSortKey(flags.sort);
      if (typeof sort === 'number') return sort;
      return runTokenCountCmd({
        patterns: patterns ?? [],
        sort,
        json: flags.json === true,
        // cac: flags.strip defaults to true; --no-strip sets it to false.
        // Python default strips frontmatter; --no-strip disables stripping.
        noStrip: flags.strip === false,
      });
    }
  }
}

/**
 * Returns a valid {@link SortKey} or a numeric exit code (1) on invalid
 * input. The callback at registration time is the only place that calls
 * process.exit for this topic — sub-handlers propagate codes upward.
 */
function resolveSortKey(value: string | undefined): SortKey | number {
  if (value === undefined) return 'tokens';
  if ((SORT_KEYS as readonly string[]).includes(value)) return value as SortKey;
  console.error(`error: --sort expected one of: ${SORT_KEYS.join(', ')} (got: ${value})`);
  return 1;
}
