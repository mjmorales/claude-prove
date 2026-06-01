/**
 * Resolve which prove tools are disabled for a project from
 * `.claude/.prove.json`.
 *
 * A tool is disabled when `tools.<name>.enabled === false`. The returned set
 * keys match `ProveHookSpec.tool` (acb, run_state, cafi, scrum, …) so it can be
 * passed straight to `writeSettingsHooks({ disabledTools })`. A missing or
 * unparseable config yields an empty set — every tool is treated as enabled, so
 * a broken config never silently strips hooks.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ToolEntry {
  enabled?: unknown;
}

interface ProveConfigShape {
  tools?: Record<string, ToolEntry | undefined>;
}

export function disabledToolsFromConfig(projectRoot: string): Set<string> {
  const disabled = new Set<string>();

  let raw: string;
  try {
    raw = readFileSync(join(projectRoot, '.claude', '.prove.json'), 'utf8');
  } catch {
    return disabled;
  }

  let parsed: ProveConfigShape;
  try {
    parsed = JSON.parse(raw) as ProveConfigShape;
  } catch {
    return disabled;
  }

  const tools = parsed.tools;
  if (tools && typeof tools === 'object') {
    for (const [name, cfg] of Object.entries(tools)) {
      if (cfg && typeof cfg === 'object' && cfg.enabled === false) {
        disabled.add(name);
      }
    }
  }

  return disabled;
}
