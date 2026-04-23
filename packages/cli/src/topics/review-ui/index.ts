/**
 * Register the `review-ui` topic on the cac instance.
 *
 * cac dispatches on the first positional arg only, so sub-actions live
 * under a single `review-ui <action>` command:
 *
 *   prove review-ui config [--cwd <path>]
 *
 * Semantics:
 *   - config : emit `{ port, image, tag }` as a JSON line on stdout,
 *              filling in hardcoded defaults for any missing key.
 *              Consumed by `commands/review-ui.md` via `jq -r .port` etc.,
 *              replacing three `python3 -c 'import json,...'` one-liners.
 */

import type { CAC } from 'cac';
import { type RunConfigOptions, runConfig } from './config';

type ReviewUiAction = 'config';

const REVIEW_UI_ACTIONS: ReviewUiAction[] = ['config'];

interface ReviewUiFlags {
  cwd?: string;
}

export function register(cli: CAC): void {
  cli
    .command('review-ui <action>', `Review UI helpers (action: ${REVIEW_UI_ACTIONS.join(' | ')})`)
    .option('--cwd <path>', 'Project root to resolve .claude/.prove.json from (default: cwd)')
    .action((action: string, flags: ReviewUiFlags) => {
      if (!isReviewUiAction(action)) {
        console.error(
          `prove review-ui: unknown action '${action}'. expected one of: ${REVIEW_UI_ACTIONS.join(
            ', ',
          )}`,
        );
        process.exit(1);
      }
      const code = dispatch(action, flags);
      process.exit(code);
    });
}

function isReviewUiAction(value: string): value is ReviewUiAction {
  return (REVIEW_UI_ACTIONS as string[]).includes(value);
}

function dispatch(action: ReviewUiAction, flags: ReviewUiFlags): number {
  switch (action) {
    case 'config': {
      const opts: RunConfigOptions = { cwd: flags.cwd };
      return runConfig(opts);
    }
  }
}
