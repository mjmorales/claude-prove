/**
 * Resolve the review-ui listen port from the machine-global claude-prove config
 * at `~/.claude-prove/config.json`.
 *
 * The review UI is a single per-machine loopback daemon serving every project
 * registered in the machine-global project registry, so its listen port is a
 * machine-global setting — NOT a per-project one. The port therefore lives
 * under the home-dir machine config (`review_ui_port` top-level key) rather than
 * a project's `.claude/.prove.json::tools.acb.config`.
 *
 * A missing or malformed config, or an absent/invalid `review_ui_port`, falls
 * back to the hardcoded default — the reader never throws, so a fresh machine
 * with no config file still resolves a usable port.
 */

import { readMachineConfig } from '@claude-prove/store';

/** Default review-ui port when the machine config carries no `review_ui_port`. */
export const DEFAULT_REVIEW_UI_PORT = 5174;

export interface ResolvePortOptions {
  /**
   * Machine-config base-dir override (the `~/.claude-prove` root). The test
   * seam: tests pass a tmp dir so they never read the developer's real config.
   */
  baseOverride?: string;
}

/**
 * Resolve the configured review-ui port from `~/.claude-prove/config.json`,
 * falling back to {@link DEFAULT_REVIEW_UI_PORT} when the key is absent or not a
 * usable port number.
 */
export function resolveReviewUiPort(opts: ResolvePortOptions = {}): number {
  const config = readMachineConfig(opts.baseOverride);
  return coercePort(config.review_ui_port) ?? DEFAULT_REVIEW_UI_PORT;
}

/**
 * Coerce a config value into a positive port integer. Accepts a finite number
 * or a numeric string (so a hand-edited config with `"review_ui_port": "6000"`
 * still resolves); returns `undefined` for anything else.
 */
function coercePort(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const port = Math.trunc(value);
    return port > 0 ? port : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}
