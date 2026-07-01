/**
 * `claude-prove claude-md <generate|scan|subagent-context|validators> [--project-root] [--plugin-dir]`
 *
 * Mirrors `skills/claude-md/__main__.py` 1:1 plus the `validators` subcommand
 * used by `claude-prove handoff gather` as a plugin-dir-less
 * fallback. Hooks, the skill body, and `/prove:docs claude-md` call
 * `claude-prove claude-md` — never `python3 skills/claude-md/__main__.py`.
 *
 *   claude-prove claude-md generate         → scan + write <project-root>/CLAUDE.md; prints JSON status.
 *   claude-prove claude-md scan             → scanner output only; prints pretty JSON.
 *   claude-prove claude-md subagent-context → compact discovery context (markdown).
 *   claude-prove claude-md validators       → list `- <phase>: `<command>`` lines from .claude/.prove.json.
 *
 * Safety guard: refuses to run when `--project-root` resolves to (or under)
 * `~/.claude`, which is the plugin install location — generating against it
 * would overwrite the plugin's own CLAUDE.md.
 *
 * Exit codes: 0 success, 2 on the ~/.claude safety guard trip.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PLUGIN_DIR_ENV_VAR,
  PROJECT_LINK_REL,
  ensureProjectLink,
  ensureStableRoot,
  resolvePluginRoot,
  stableRootPath,
} from '@claude-prove/installer';
import { compose, composeSubagentContext, writeClaudeMd } from '../composer';
import { type ScanResult, scanProject } from '../scanner';

export interface ClaudeMdOpts {
  projectRoot?: string;
  pluginDir?: string;
}

function resolveProjectRoot(opts: ClaudeMdOpts): string {
  return resolve(opts.projectRoot ?? process.cwd());
}

function isPluginDir(dir: string): boolean {
  return existsSync(join(dir, '.claude-plugin', 'plugin.json'));
}

function pluginDirCandidate(dir: string | undefined): string | null {
  if (!dir) return null;
  try {
    const real = realpathSync(dir);
    return isPluginDir(real) ? real : null;
  } catch {
    return null;
  }
}

// resolvePluginRoot honors $CLAUDE_PROVE_PLUGIN_DIR/$CLAUDE_PLUGIN_ROOT plus a
// dev-checkout walk-up, but a release binary run from a bare shell has neither
// (its walk-up starts at the CI build path; the installer default is wrong
// under claude-env), so fall back to prove's own symlink chain before it.
export function resolvePluginDir(opts: ClaudeMdOpts, projectRoot: string): string {
  if (opts.pluginDir) return resolve(opts.pluginDir);
  const viaResolver = resolvePluginRoot();
  if (isPluginDir(viaResolver)) return viaResolver;
  return (
    pluginDirCandidate(join(projectRoot, PROJECT_LINK_REL)) ??
    pluginDirCandidate(stableRootPath()) ??
    viaResolver
  );
}

// prove.exists with no version and no commands means the plugin dir resolved to
// a non-plugin path: the file would drop the version banner and command list.
export function pluginMetadataMissing(scan: ScanResult): boolean {
  return (
    scan.prove_config.exists &&
    (scan.plugin_version === 'unknown' || scan.core_commands.length === 0)
  );
}

/**
 * Refuse to run against `~/.claude` (the plugin install directory). Mirrors
 * the guard in `skills/claude-md/__main__.py::main`.
 *
 * Returns 2 (the guarded exit code) when the check trips, null otherwise.
 * Returning instead of calling process.exit keeps the guard testable and
 * consistent with the rest of the module's numeric exit-code convention.
 */
function assertNotPluginInstall(projectRoot: string): number | null {
  const claudeDir = resolve(homedir(), '.claude');
  const isUnder = projectRoot === claudeDir || projectRoot.startsWith(`${claudeDir}/`);
  if (isUnder) {
    process.stderr.write(
      `ERROR: --project-root is inside ~/.claude/ (the plugin install location).\nRun this command targeting your project root, not the plugin directory.\n  project-root: ${projectRoot}\n`,
    );
    return 2;
  }
  return null;
}

/** `generate` — scan project and write CLAUDE.md; prints JSON status to stdout. */
export function runGenerate(opts: ClaudeMdOpts): number {
  const projectRoot = resolveProjectRoot(opts);
  const pluginDir = resolvePluginDir(opts, projectRoot);
  const guard = assertNotPluginInstall(projectRoot);
  if (guard !== null) return guard;

  // Refresh both symlink hops so the hardcoded .claude/prove-plugin/...
  // @-references resolve when the file is written; failure warns, never blocks.
  try {
    ensureStableRoot(pluginDir);
    ensureProjectLink(projectRoot);
  } catch (err) {
    process.stderr.write(
      `WARN: reference-symlink refresh failed (generated @-references may not resolve): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const scan = scanProject(projectRoot, pluginDir);
  if (pluginMetadataMissing(scan)) {
    process.stderr.write(
      `WARN: prove is configured but the plugin dir did not resolve at ${pluginDir} (plugin_version=${scan.plugin_version}, core_commands=${scan.core_commands.length}); CLAUDE.md will omit the version banner and Prove Commands list — pass --plugin-dir or set ${PLUGIN_DIR_ENV_VAR}.\n`,
    );
  }

  // Guard compose/write so a permission or missing-parent error exits cleanly.
  let content: string;
  let path: string;
  try {
    content = compose(scan, pluginDir);
    path = writeClaudeMd(projectRoot, content);
  } catch (err) {
    process.stderr.write(
      `ERROR: could not write CLAUDE.md: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const status = {
    status: 'generated',
    path,
    sections: countSections(content),
  };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  return 0;
}

/** `scan` — run scanner only, emit scan dict as pretty JSON. */
export function runScan(opts: ClaudeMdOpts): number {
  const projectRoot = resolveProjectRoot(opts);
  const pluginDir = resolvePluginDir(opts, projectRoot);
  const guard = assertNotPluginInstall(projectRoot);
  if (guard !== null) return guard;

  const scan = scanProject(projectRoot, pluginDir);
  process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
  return 0;
}

/** `subagent-context` — emit the compact discovery context block as markdown. */
export function runSubagentContext(opts: ClaudeMdOpts): number {
  const projectRoot = resolveProjectRoot(opts);
  const pluginDir = resolvePluginDir(opts, projectRoot);
  const guard = assertNotPluginInstall(projectRoot);
  if (guard !== null) return guard;

  const scan = scanProject(projectRoot, pluginDir);
  process.stdout.write(composeSubagentContext(scan, pluginDir));
  return 0;
}

interface ValidatorEntry {
  phase?: string;
  command?: string;
  prompt?: string;
  name?: string;
}

/**
 * `validators` — emit one `- <phase>: `<command>`` line per validator with a
 * non-empty command. Reads `.claude/.prove.json` from `--project-root` (or
 * cwd). Missing file, missing `validators` key, malformed JSON → no output,
 * exit 0 (matches the former gather-context.sh fallback which wrapped
 * the read in `|| true`).
 */
export function runValidators(opts: ClaudeMdOpts): number {
  const projectRoot = resolveProjectRoot(opts);
  const configPath = join(projectRoot, '.claude', '.prove.json');
  if (!existsSync(configPath)) return 0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;

  const validators = (parsed as { validators?: unknown }).validators;
  if (!Array.isArray(validators)) return 0;

  const lines: string[] = [];
  for (const entry of validators) {
    if (!entry || typeof entry !== 'object') continue;
    const v = entry as ValidatorEntry;
    const phase = v.phase ?? '';
    const command = v.command ?? '';
    if (!command) continue;
    lines.push(`- ${phase}: \`${command}\``);
  }

  if (lines.length > 0) {
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return 0;
}

function countSections(content: string): number {
  let count = 0;
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) count++;
  }
  return count;
}
