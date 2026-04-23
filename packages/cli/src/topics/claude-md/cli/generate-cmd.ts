/**
 * `prove claude-md <generate|scan|subagent-context|validators> [--project-root] [--plugin-dir]`
 *
 * Mirrors `skills/claude-md/__main__.py` 1:1 plus the `validators` subcommand
 * used by `skills/handoff/scripts/gather-context.sh` as a plugin-dir-less
 * fallback. Hooks, the skill body, and `/prove:docs claude-md` call
 * `prove claude-md` — never `python3 skills/claude-md/__main__.py`.
 *
 *   prove claude-md generate         → scan + write <project-root>/CLAUDE.md; prints JSON status.
 *   prove claude-md scan             → scanner output only; prints pretty JSON.
 *   prove claude-md subagent-context → compact discovery context (markdown).
 *   prove claude-md validators       → list `- <phase>: `<command>`` lines from .claude/.prove.json.
 *
 * Safety guard: refuses to run when `--project-root` resolves to (or under)
 * `~/.claude`, which is the plugin install location — generating against it
 * would overwrite the plugin's own CLAUDE.md.
 *
 * Exit codes: 0 success, 2 on the ~/.claude safety guard trip.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { compose, composeSubagentContext, writeClaudeMd } from '../composer';
import { scanProject } from '../scanner';

export interface ClaudeMdOpts {
  projectRoot?: string;
  pluginDir?: string;
}

/** Default plugin dir when the caller omits `--plugin-dir`.  */
function derivePluginDir(): string {
  // The real prove CLI lives at <plugin>/packages/cli/bin/run.ts. From this
  // compiled file location (src/topics/claude-md/cli/generate-cmd.ts) the
  // plugin root is five levels up.
  return resolve(__dirname, '..', '..', '..', '..', '..');
}

function resolveProjectRoot(opts: ClaudeMdOpts): string {
  return resolve(opts.projectRoot ?? process.cwd());
}

function resolvePluginDir(opts: ClaudeMdOpts): string {
  return resolve(opts.pluginDir ?? derivePluginDir());
}

/**
 * Refuse to run against `~/.claude` (the plugin install directory). Mirrors
 * the guard in `skills/claude-md/__main__.py::main`.
 */
function assertNotPluginInstall(projectRoot: string): void {
  const claudeDir = resolve(homedir(), '.claude');
  const isUnder = projectRoot === claudeDir || projectRoot.startsWith(`${claudeDir}/`);
  if (isUnder) {
    process.stderr.write(
      `ERROR: --project-root is inside ~/.claude/ (the plugin install location).\nRun this command targeting your project root, not the plugin directory.\n  project-root: ${projectRoot}\n`,
    );
    process.exit(2);
  }
}

/** `generate` — scan project and write CLAUDE.md; prints JSON status to stdout. */
export function runGenerate(opts: ClaudeMdOpts): number {
  const projectRoot = resolveProjectRoot(opts);
  const pluginDir = resolvePluginDir(opts);
  assertNotPluginInstall(projectRoot);

  const scan = scanProject(projectRoot, pluginDir);
  const content = compose(scan, pluginDir);
  const path = writeClaudeMd(projectRoot, content);

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
  const pluginDir = resolvePluginDir(opts);
  assertNotPluginInstall(projectRoot);

  const scan = scanProject(projectRoot, pluginDir);
  process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
  return 0;
}

/** `subagent-context` — emit the compact discovery context block as markdown. */
export function runSubagentContext(opts: ClaudeMdOpts): number {
  const projectRoot = resolveProjectRoot(opts);
  const pluginDir = resolvePluginDir(opts);
  assertNotPluginInstall(projectRoot);

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
 * exit 0 (matches the Python fallback in `gather-context.sh` which wrapped
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
