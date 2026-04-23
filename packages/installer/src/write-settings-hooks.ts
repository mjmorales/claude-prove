/**
 * Idempotent merge of prove-owned hook blocks into `.claude/settings.json`.
 *
 * Prove-owned blocks are tagged with `_tool` (values: `acb`, `run_state`,
 * `cafi`). The merge preserves any user-authored block (no `_tool`) byte-
 * for-byte. Writes go through a temp file + rename for atomicity, and
 * malformed source JSON triggers `SettingsParseError` without partial writes.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export type HookType = 'command';

export interface HookEntry {
  type: HookType;
  command: string;
  timeout?: number;
  if?: string;
}

export interface HookBlock {
  matcher: string;
  hooks: HookEntry[];
  _tool?: string;
  [key: string]: unknown;
}

export type EventName = 'PostToolUse' | 'PreToolUse' | 'SessionStart' | 'Stop' | 'SubagentStop';

export interface SettingsFile {
  hooks?: Partial<Record<EventName, HookBlock[]>>;
  [k: string]: unknown;
}

export interface Options {
  force?: boolean;
}

/** Thrown when `.claude/settings.json` exists but cannot be parsed as JSON. */
export class SettingsParseError extends Error {
  public readonly path: string;
  public readonly parseError: Error;

  constructor(path: string, parseError: Error) {
    super(`Failed to parse settings file at ${path}: ${parseError.message}`);
    this.name = 'SettingsParseError';
    this.path = path;
    this.parseError = parseError;
  }
}

/**
 * Canonical shape of a prove-owned hook block. The `commandSuffix` is
 * appended to the runtime `prefix` (e.g. `bun run /path/to/run.ts`) to
 * form the final command string.
 */
export interface ProveHookSpec {
  event: EventName;
  matcher: string;
  tool: string;
  commandSuffix: string;
  timeout: number;
  if?: string;
}

/**
 * Canonical prove-owned hook blocks. Order matters: emission order matches
 * the current repo's `.claude/settings.json` so a fresh install produces a
 * byte-identical file (modulo prefix).
 */
export const PROVE_HOOK_BLOCKS: readonly ProveHookSpec[] = [
  {
    event: 'PostToolUse',
    matcher: 'Bash',
    tool: 'acb',
    commandSuffix: 'acb hook post-commit --workspace-root $CLAUDE_PROJECT_DIR',
    timeout: 10000,
    if: 'Bash(git commit*)',
  },
  {
    event: 'PostToolUse',
    matcher: 'Write|Edit|MultiEdit',
    tool: 'run_state',
    commandSuffix: 'run-state hook validate',
    timeout: 5000,
  },
  {
    event: 'PreToolUse',
    matcher: 'Glob|Grep',
    tool: 'cafi',
    commandSuffix: 'cafi gate',
    timeout: 10000,
  },
  {
    event: 'PreToolUse',
    matcher: 'Write|Edit|MultiEdit',
    tool: 'run_state',
    commandSuffix: 'run-state hook guard',
    timeout: 5000,
  },
  {
    event: 'SessionStart',
    matcher: 'resume|compact',
    tool: 'run_state',
    commandSuffix: 'run-state hook session-start',
    timeout: 3000,
  },
  {
    event: 'Stop',
    matcher: '',
    tool: 'run_state',
    commandSuffix: 'run-state hook stop',
    timeout: 5000,
  },
  {
    event: 'SubagentStop',
    matcher: 'general-purpose',
    tool: 'run_state',
    commandSuffix: 'run-state hook subagent-stop',
    timeout: 5000,
  },
] as const;

/**
 * Build the full command string for a spec given a runtime prefix.
 *
 * `prefix` is typically `bun run <abs-path-to-cli/bin/run.ts>`.
 */
function buildCommand(prefix: string, suffix: string): string {
  return `${prefix} ${suffix}`;
}

/**
 * Build the canonical hook entry for a spec. Construction order mirrors the
 * current `.claude/settings.json` so JSON.stringify preserves the same key
 * order: `type`, optional `if`, `command`, `timeout`.
 */
function buildHookEntry(spec: ProveHookSpec, prefix: string): HookEntry {
  const entry: HookEntry =
    spec.if !== undefined
      ? {
          type: 'command',
          if: spec.if,
          command: buildCommand(prefix, spec.commandSuffix),
          timeout: spec.timeout,
        }
      : {
          type: 'command',
          command: buildCommand(prefix, spec.commandSuffix),
          timeout: spec.timeout,
        };
  return entry;
}

/** Build the canonical block object for a spec. Keeps key order stable. */
function buildBlock(spec: ProveHookSpec, prefix: string): HookBlock {
  return {
    matcher: spec.matcher,
    hooks: [buildHookEntry(spec, prefix)],
    _tool: spec.tool,
  };
}

/** Read settings JSON, or return empty scaffold when the file is missing. */
function readSettings(path: string): SettingsFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { hooks: {} };
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as SettingsFile;
    if (parsed.hooks === undefined) parsed.hooks = {};
    return parsed;
  } catch (err) {
    throw new SettingsParseError(path, err as Error);
  }
}

/**
 * Find an existing prove-owned block matching `(matcher, _tool)`. Blocks
 * without a `_tool` field are user-authored and never matched.
 */
function findProveBlock(
  blocks: HookBlock[] | undefined,
  matcher: string,
  tool: string,
): HookBlock | undefined {
  if (!blocks) return undefined;
  return blocks.find((b) => b._tool === tool && b.matcher === matcher);
}

/**
 * Merge prove-owned hook blocks into `settingsPath`.
 *
 * Behavior:
 * - Missing file → scaffold `{ hooks: {} }` and emit all canonical blocks.
 * - Existing prove block with matching command → no-op (unless `opts.force`).
 * - Existing prove block with stale command → rewrite command + timeout,
 *   preserve any extra keys on the block.
 * - Missing prove block → append.
 * - Blocks without `_tool` are never touched.
 *
 * Writes atomically via `<path>.tmp` + rename. Validates the parsed source
 * before mutation; throws `SettingsParseError` on malformed JSON without
 * writing anything.
 *
 * @returns `true` if the file was written, `false` if no changes were needed.
 */
export function writeSettingsHooks(
  settingsPath: string,
  prefix: string,
  opts: Options = {},
): boolean {
  const settings = readSettings(settingsPath);
  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks;

  let mutated = false;

  for (const spec of PROVE_HOOK_BLOCKS) {
    const eventBlocks = hooks[spec.event] ?? [];
    const desiredCommand = buildCommand(prefix, spec.commandSuffix);
    const existing = findProveBlock(eventBlocks, spec.matcher, spec.tool);

    if (existing) {
      const entry = existing.hooks[0];
      const inSync =
        entry !== undefined &&
        entry.command === desiredCommand &&
        entry.timeout === spec.timeout &&
        entry.if === spec.if;

      if (inSync && !opts.force) continue;

      // Rewrite the single hook entry while preserving any extra keys on
      // the outer block (e.g. future metadata users may add alongside
      // `_tool`). `hooks[0]` is the only entry we own.
      existing.hooks = [buildHookEntry(spec, prefix)];
      mutated = true;
      continue;
    }

    // No matching prove block → append.
    if (!hooks[spec.event]) hooks[spec.event] = [];
    hooks[spec.event]?.push(buildBlock(spec, prefix));
    mutated = true;
  }

  if (!mutated) return false;

  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  const tmp = `${settingsPath}.tmp`;
  writeFileSync(tmp, serialized, 'utf8');
  // Sanity re-parse before rename: if we somehow produced invalid JSON we
  // want to fail loud rather than overwrite the real file.
  try {
    JSON.parse(serialized);
  } catch (err) {
    throw new SettingsParseError(tmp, err as Error);
  }
  renameSync(tmp, settingsPath);
  return true;
}
