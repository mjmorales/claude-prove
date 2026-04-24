/**
 * `claude-prove install doctor` — report health of the prove installation.
 *
 * Runs a fixed sequence of non-invasive checks. Each check returns a
 * `CheckResult` with pass/fail/warn status and an actionable `fix` hint.
 * Output is a single line per check plus a one-line summary.
 *
 * Exit codes:
 *   0 — every check passed (warnings allowed)
 *   1 — one or more checks failed
 *
 * Checks (in order):
 *   1. plugin-root        — resolvePluginRoot() points at a dir with
 *                           `.claude-plugin/plugin.json`
 *   2. mode               — detectMode() returns 'dev' or 'compiled'
 *   3. binary-on-path     — (compiled mode only) `which claude-prove` hits
 *   4. hook-paths         — each prove-owned hook block in
 *                           `.claude/settings.json` points at an
 *                           executable command
 *   5. prove-json-version — `.claude/.prove.json` parses and its
 *                           schema_version matches CURRENT_SCHEMA_VERSION
 *   6. claude-cli         — `which claude` (warn on miss, never fail)
 */

import { constants, accessSync, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { type Mode, detectMode } from '@claude-prove/installer/detect-mode';
import { resolvePluginRoot } from '@claude-prove/installer/plugin-root';
import type { HookBlock, SettingsFile } from '@claude-prove/installer/write-settings-hooks';
import { CURRENT_SCHEMA_VERSION } from '../schema/schemas';

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

interface DoctorOptions {
  /** Project root scanned for `.claude/settings.json` + `.claude/.prove.json`. */
  cwd?: string;
}

const DEFAULT_SETTINGS_REL = join('.claude', 'settings.json');
const DEFAULT_PROVE_JSON_REL = join('.claude', '.prove.json');

/**
 * Handler for the `doctor` action under the `install <action>` command.
 * Exported so the parent `install/index.ts` can dispatch on action.
 */
export function handleDoctorAction(): number {
  const results = runDoctor({ cwd: process.cwd() });
  return printResults(results);
}

/** Run all checks and return their structured results in execution order. */
export function runDoctor(opts: DoctorOptions = {}): CheckResult[] {
  const cwd = opts.cwd ?? process.cwd();
  const results: CheckResult[] = [];

  const rootResult = checkPluginRoot();
  results.push(rootResult);

  const root = rootResult.status === 'pass' ? rootResult.message : undefined;
  const modeResult = checkMode(root);
  results.push(modeResult);

  const mode = modeResult.status === 'pass' ? (modeResult.message as Mode) : undefined;
  if (mode === 'compiled') {
    results.push(checkBinaryOnPath());
  }

  results.push(...checkSettingsHookPaths(cwd));
  results.push(checkProveJsonSchemaVersion(cwd));
  results.push(checkClaudeCli());

  return results;
}

/** Verify resolvePluginRoot() finds an existing `.claude-plugin/plugin.json`. */
function checkPluginRoot(): CheckResult {
  const root = resolvePluginRoot();
  const marker = join(root, '.claude-plugin', 'plugin.json');
  if (!existsSync(marker)) {
    return {
      name: 'plugin-root',
      status: 'fail',
      message: `plugin root not found at ${root} (missing ${marker})`,
      fix: 'set $CLAUDE_PLUGIN_ROOT to your plugin checkout or reinstall the plugin',
    };
  }
  return { name: 'plugin-root', status: 'pass', message: root };
}

/** Confirm detectMode runs and returns a non-empty mode tag. */
function checkMode(root: string | undefined): CheckResult {
  if (!root) {
    return {
      name: 'mode',
      status: 'fail',
      message: 'cannot detect mode without a resolved plugin root',
      fix: 'fix the plugin-root check first',
    };
  }
  try {
    const mode = detectMode(root);
    return { name: 'mode', status: 'pass', message: mode };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'mode',
      status: 'fail',
      message: `detectMode failed: ${msg}`,
      fix: 'report this to the prove maintainers',
    };
  }
}

/** Verify `claude-prove` resolves on $PATH. Compiled installs only. */
function checkBinaryOnPath(): CheckResult {
  const found = which('claude-prove');
  if (found) {
    return { name: 'binary-on-path', status: 'pass', message: found };
  }
  return {
    name: 'binary-on-path',
    status: 'fail',
    message: '`claude-prove` not found on $PATH',
    fix: 'add ~/.local/bin to PATH or run `claude-prove install upgrade` (or re-run `bash <plugin>/scripts/install.sh`)',
  };
}

/**
 * For every prove-owned hook block in `.claude/settings.json`, verify the
 * command prefix points at something executable. Returns one result per
 * block (or a single informational pass when the file is absent).
 */
function checkSettingsHookPaths(cwd: string): CheckResult[] {
  const path = join(cwd, DEFAULT_SETTINGS_REL);
  if (!existsSync(path)) {
    return [
      {
        name: 'hook-paths',
        status: 'warn',
        message: `no ${DEFAULT_SETTINGS_REL} at ${cwd}`,
        fix: 'run `claude-prove install init` to scaffold hook blocks',
      },
    ];
  }

  let settings: SettingsFile;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8')) as SettingsFile;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      {
        name: 'hook-paths',
        status: 'fail',
        message: `failed to parse ${path}: ${msg}`,
        fix: 'fix the JSON syntax or run `claude-prove install init --force`',
      },
    ];
  }

  const proveBlocks = collectProveBlocks(settings);
  if (proveBlocks.length === 0) {
    return [
      {
        name: 'hook-paths',
        status: 'warn',
        message: `no prove-owned hook blocks in ${DEFAULT_SETTINGS_REL}`,
        fix: 'run `claude-prove install init` to scaffold hook blocks',
      },
    ];
  }

  return proveBlocks.map(checkHookBlock);
}

/**
 * Extract every hook block tagged with `_tool` (prove-owned). User-authored
 * blocks without `_tool` are skipped — we never audit them.
 */
function collectProveBlocks(settings: SettingsFile): HookBlock[] {
  const result: HookBlock[] = [];
  const hooks = settings.hooks ?? {};
  for (const blocks of Object.values(hooks)) {
    if (!blocks) continue;
    for (const block of blocks) {
      if (typeof block._tool === 'string') result.push(block);
    }
  }
  return result;
}

/**
 * Validate a single prove-owned hook block.
 *
 * Two command shapes are in use:
 *   1. `bun run <abs-path-to-run.ts> <subcommand>` — dev mode
 *   2. `<abs-path-to-binary> <subcommand>`        — compiled mode
 *
 * For shape 1 we stat the script file. For shape 2 we require the binary
 * to be executable (X_OK). Either kind failing yields a `fail` with the
 * `--force` fix hint so `claude-prove install init --force` rewrites the block.
 *
 * Iterates every entry in `block.hooks` — multi-entry blocks must not be
 * silently passed based solely on entry[0]. First failure wins; a block
 * with zero entries fails with an empty-block message.
 */
function checkHookBlock(block: HookBlock): CheckResult {
  const tool = block._tool ?? '<unknown>';
  const name = `hook-paths[${tool}:${block.matcher}]`;

  if (block.hooks.length === 0) {
    return {
      name,
      status: 'fail',
      message: 'hook block has no entries',
      fix: 'run `claude-prove install init --force`',
    };
  }

  const verifiedPaths: string[] = [];
  for (const entry of block.hooks) {
    if (!entry || typeof entry.command !== 'string') {
      return {
        name,
        status: 'fail',
        message: 'hook block has no command',
        fix: 'run `claude-prove install init --force`',
      };
    }

    const tokens = entry.command.trim().split(/\s+/);
    const target = extractHookTarget(tokens);
    if (!target) {
      return {
        name,
        status: 'fail',
        message: `could not parse hook command: ${entry.command}`,
        fix: 'run `claude-prove install init --force`',
      };
    }

    const verdict = verifyHookTarget(target);
    if (verdict.status !== 'pass') {
      return {
        name,
        status: 'fail',
        message: verdict.message,
        fix: 'run `claude-prove install init --force`',
      };
    }
    verifiedPaths.push(target.path);
  }

  return { name, status: 'pass', message: verifiedPaths.join(', ') };
}

interface HookTarget {
  /** 'script' for `bun run <path>`, 'binary' for a direct executable. */
  kind: 'script' | 'binary';
  path: string;
}

function extractHookTarget(tokens: string[]): HookTarget | undefined {
  const first = tokens[0];
  if (!first) return undefined;
  if (first === 'bun') {
    // Find the first positional after `run` that isn't a flag.
    const runIdx = tokens.indexOf('run');
    if (runIdx < 0) return undefined;
    for (let i = runIdx + 1; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok && !tok.startsWith('-')) return { kind: 'script', path: tok };
    }
    return undefined;
  }
  return { kind: 'binary', path: first };
}

function verifyHookTarget(target: HookTarget): { status: 'pass' | 'fail'; message: string } {
  try {
    if (target.kind === 'script') {
      const stat = statSync(target.path);
      if (!stat.isFile()) {
        return { status: 'fail', message: `hook script is not a regular file: ${target.path}` };
      }
      return { status: 'pass', message: target.path };
    }
    accessSync(target.path, constants.X_OK);
    return { status: 'pass', message: target.path };
  } catch {
    return { status: 'fail', message: `hook target missing or not executable: ${target.path}` };
  }
}

/**
 * Read `.claude/.prove.json` and confirm its `schema_version` equals the
 * current target. Missing file → warn (init hasn't run yet). Parse errors
 * and version mismatches → fail.
 */
function checkProveJsonSchemaVersion(cwd: string): CheckResult {
  const path = join(cwd, DEFAULT_PROVE_JSON_REL);
  if (!existsSync(path)) {
    return {
      name: 'prove-json-version',
      status: 'warn',
      message: `no ${DEFAULT_PROVE_JSON_REL} at ${cwd}`,
      fix: 'run `claude-prove install init-config` to bootstrap it',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'prove-json-version',
      status: 'fail',
      message: `failed to parse ${path}: ${msg}`,
      fix: 'fix the JSON syntax or run `claude-prove install init-config --force`',
    };
  }

  const version =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).schema_version
      : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    return {
      name: 'prove-json-version',
      status: 'fail',
      message: `${DEFAULT_PROVE_JSON_REL} is missing schema_version`,
      fix: 'run `claude-prove schema migrate`',
    };
  }
  if (version !== CURRENT_SCHEMA_VERSION) {
    return {
      name: 'prove-json-version',
      status: 'fail',
      message: `schema_version ${version} != current ${CURRENT_SCHEMA_VERSION}`,
      fix: 'run `claude-prove schema migrate`',
    };
  }
  return { name: 'prove-json-version', status: 'pass', message: `v${version}` };
}

/** Warn (not fail) when the Claude Code CLI is not on $PATH. */
function checkClaudeCli(): CheckResult {
  const found = which('claude');
  if (found) {
    return { name: 'claude-cli', status: 'pass', message: found };
  }
  return {
    name: 'claude-cli',
    status: 'warn',
    message: '`claude` not found on $PATH',
    fix: 'install the Claude Code CLI (https://docs.claude.com/claude-code)',
  };
}

/** Minimal `which` — walks $PATH looking for an executable file. */
function which(cmd: string): string | undefined {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return undefined;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here, keep looking
    }
  }
  return undefined;
}

/**
 * Render results to stdout/stderr and return the exit code.
 * Warnings never fail the run; only hard failures do.
 */
export function printResults(results: CheckResult[]): number {
  let passed = 0;
  let warnings = 0;
  let failures = 0;

  for (const r of results) {
    const icon = r.status === 'pass' ? '[PASS]' : r.status === 'warn' ? '[WARN]' : '[FAIL]';
    const stream = r.status === 'fail' ? process.stderr : process.stdout;
    stream.write(`${icon} ${r.name}: ${r.message}\n`);
    if (r.fix) {
      stream.write(`  fix: ${r.fix}\n`);
    }
    if (r.status === 'pass') passed++;
    else if (r.status === 'warn') warnings++;
    else failures++;
  }

  process.stdout.write('\n');
  process.stdout.write(`${passed} passed, ${warnings} warnings, ${failures} failures\n`);
  return failures > 0 ? 1 : 0;
}
