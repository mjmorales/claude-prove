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
 *   4. plugin-dir-env     — (only when hooks use the interpolated
 *                           `${CLAUDE_PROVE_PLUGIN_DIR:-...}` form) the value the
 *                           expansion resolves to — process env, then the
 *                           `.claude/settings.local.json` env block, then the
 *                           default plugin install path — contains the dev
 *                           entry point
 *   5. stable-root        — (only when the project CLAUDE.md references
 *                           `@.claude/prove-plugin`) the reference symlink
 *                           chain (project link -> ~/.claude-prove/latest ->
 *                           plugin dir) exists and resolves; a broken hop
 *                           means those @-imports silently fail to load
 *   6. hook-paths         — each prove-owned hook block in
 *                           `.claude/settings.json` points at an executable
 *                           command (interpolated forms are expanded the way
 *                           the firing shell would; bare commands resolve on
 *                           $PATH); machine-absolute dev prefixes from the
 *                           pre-portable format warn
 *   7. hook-exec          — each distinct hook command target actually
 *                           executes (`--version` probe): a path can exist
 *                           yet still die at fire time, e.g. a `bun run`
 *                           wrapper against a marketplace clone whose
 *                           workspace deps were never installed
 *   8. prove-json-version — `.claude/.prove.json` parses and its
 *                           schema_version matches CURRENT_SCHEMA_VERSION
 *   9. team-agent-markers — (only when `.claude/agents/` holds any
 *                           `team-<slug>-<role>.md` file) each such file carries
 *                           a single well-formed engine-owned region: both
 *                           generated markers present, BEGIN before END, neither
 *                           duplicated. A malformed/missing region means a later
 *                           regeneration cannot splice the block in place
 *  10. team-agent-drift   — (only when the scrum store exists) the on-disk
 *                           team-agent files reconcile with the active-team
 *                           registry: every active team has all three role
 *                           files, and no role file survives for an
 *                           unknown/inactive team
 *  11. claude-cli         — `which claude` (warn on miss, never fail)
 *
 * The `--version` probe is the one check that executes a hook target; it is
 * read-only and side-effect free, keeping doctor non-invasive. The two
 * team-agent checks are likewise report-only: they read files and the registry
 * and surface drift, but never write — the repair path they name is
 * `scrum team sync-agents`.
 */

import {
  constants,
  accessSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type Mode, detectMode } from '@claude-prove/installer/detect-mode';
import { PLUGIN_DIR_ENV_VAR, resolvePluginRoot } from '@claude-prove/installer/plugin-root';
import type { HookBlock, SettingsFile } from '@claude-prove/installer/write-settings-hooks';
import { CURRENT_SCHEMA_VERSION } from '../schema/schemas';
import { TEAM_AGENT_BEGIN_MARKER, TEAM_AGENT_END_MARKER } from '../scrum/cli/team-agent-artifact';
import { openScrumStore } from '../scrum/store';
import { TEAM_ROLES, type Team, type TeamRole } from '../scrum/types';

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
const DEFAULT_LOCAL_SETTINGS_REL = join('.claude', 'settings.local.json');
/** Default Claude Code plugin install path — the `${VAR:-default}` fallback. */
const DEFAULT_PLUGIN_INSTALL = join(homedir(), '.claude', 'plugins', 'prove');
/** Relative path of the dev-mode CLI entry point inside a plugin dir. */
const DEV_ENTRY_REL = join('packages', 'cli', 'bin', 'run.ts');
/** Marker identifying the portable interpolated hook-command form. */
const INTERPOLATION_MARKER = `\${${PLUGIN_DIR_ENV_VAR}:-`;

/**
 * Handler for the `doctor` action under the `install <action>` command.
 * Exported so the parent `install/index.ts` can dispatch on action.
 */
export async function handleDoctorAction(): Promise<number> {
  const results = await runDoctor({ cwd: process.cwd() });
  return printResults(results);
}

/** Run all checks and return their structured results in execution order. */
export async function runDoctor(opts: DoctorOptions = {}): Promise<CheckResult[]> {
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

  // Resolve the plugin dir exactly as a fired hook's shell expansion would,
  // so plugin-dir-env and hook-paths audit what will actually run.
  const localPluginDir = resolveLocalPluginDir(cwd);
  if (settingsUseInterpolation(cwd)) {
    results.push(checkPluginDirEnv(localPluginDir));
  }

  const stableRoot = checkStableRoot(cwd);
  if (stableRoot) results.push(stableRoot);

  const hookPaths = checkSettingsHookPaths(cwd, localPluginDir.dir);
  results.push(...hookPaths.results);
  results.push(...checkHookExec(hookPaths.targets));
  results.push(checkProveJsonSchemaVersion(cwd));

  const markerCheck = checkTeamAgentMarkers(cwd);
  if (markerCheck) results.push(markerCheck);
  const driftCheck = await checkTeamAgentRegistryDrift(cwd);
  if (driftCheck) results.push(driftCheck);

  results.push(checkClaudeCli());

  return results;
}

/**
 * Verify the symlink chain behind the project's generated
 * `@.claude/prove-plugin/...` references
 * (`.claude/prove-plugin -> ~/.claude-prove/latest -> plugin dir`).
 * Runs only when the project's CLAUDE.md actually references the project
 * link; a missing or dangling hop means every such import silently fails
 * to load.
 */
function checkStableRoot(cwd: string): CheckResult | undefined {
  let claudeMd: string;
  try {
    claudeMd = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
  } catch {
    return undefined;
  }
  const refToken = '.claude/prove-plugin';
  if (!claudeMd.includes(`@${refToken}`)) return undefined;

  const linkPath = join(cwd, refToken);
  const fix =
    'run `claude-prove claude-md generate --project-root "$(pwd)"` (or `claude-prove install local-env --plugin-dir <checkout>` on dev machines) to rebuild the symlink chain';

  let target: string;
  try {
    const st = lstatSync(linkPath);
    if (!st.isSymbolicLink()) {
      return {
        name: 'stable-root',
        status: 'fail',
        message: `${linkPath} exists but is not a symlink`,
        fix: 'move it aside, then re-run the fix command',
      };
    }
    target = readlinkSync(linkPath);
  } catch {
    return {
      name: 'stable-root',
      status: 'fail',
      message: `CLAUDE.md references @${refToken} but ${linkPath} does not exist`,
      fix,
    };
  }

  // existsSync follows the whole chain — false means some hop dangles
  // (typically the machine-global ~/.claude-prove/latest hop).
  if (!existsSync(linkPath)) {
    return {
      name: 'stable-root',
      status: 'fail',
      message: `${linkPath} chain dangles (-> ${target})`,
      fix,
    };
  }
  return { name: 'stable-root', status: 'pass', message: `${linkPath} -> ${target}` };
}

// ---------------------------------------------------------------------------
// Team-agent file integrity (report-only; repair path = scrum team sync-agents)
// ---------------------------------------------------------------------------

const AGENTS_DIR_REL = join('.claude', 'agents');
const PROVE_DB_REL = join('.prove', 'prove.db');
/** The repair command every failing team-agent check names. */
const SYNC_AGENTS_FIX = 'run `claude-prove scrum team sync-agents` to regenerate the role files';

/** A discovered on-disk team-agent file, with its (slug, role) parsed out. */
interface TeamAgentFile {
  /** Absolute path under `.claude/agents/`. */
  path: string;
  /** Bare filename, for human-readable messages. */
  name: string;
  slug: string;
  role: TeamRole;
}

/**
 * Discover every `.claude/agents/team-<slug>-<role>.md` file and parse its
 * (slug, role). A slug may itself contain hyphens, so the role is matched
 * against the closed `TEAM_ROLES` suffix set rather than split on the last
 * hyphen — `team-foo-bar-engineer.md` is slug `foo-bar`, role `engineer`.
 * Files that match the `team-…` prefix but carry no known role suffix are not
 * team-agent files and are skipped. Returns `undefined` when the agents dir is
 * absent (nothing to check), an empty array when present but holding none.
 */
function discoverTeamAgentFiles(cwd: string): TeamAgentFile[] | undefined {
  const dir = join(cwd, AGENTS_DIR_REL);
  if (!existsSync(dir)) return undefined;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }

  const files: TeamAgentFile[] = [];
  for (const name of entries) {
    if (!name.startsWith('team-') || !name.endsWith('.md')) continue;
    const stem = name.slice('team-'.length, -'.md'.length);
    const role = TEAM_ROLES.find((r) => stem === r || stem.endsWith(`-${r}`));
    if (!role) continue;
    const slug = stem.slice(0, stem.length - role.length).replace(/-$/, '');
    if (slug.length === 0) continue;
    files.push({ path: join(dir, name), name, slug, role });
  }
  return files;
}

/**
 * Verify the engine-owned generated region in each team-agent file is intact:
 * both markers present, BEGIN strictly before END, and neither marker
 * duplicated. A broken region is the one shape the marker-merge writer cannot
 * re-splice in place — it would prepend a second region instead, so doctor
 * surfaces it before that drift compounds. Runs only when team-agent files
 * exist; skips cleanly otherwise.
 */
function checkTeamAgentMarkers(cwd: string): CheckResult | undefined {
  const files = discoverTeamAgentFiles(cwd);
  if (!files || files.length === 0) return undefined;

  const malformed: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file.path, 'utf8');
    } catch {
      malformed.push(`${file.name} (unreadable)`);
      continue;
    }
    const reason = markerDefect(content);
    if (reason) malformed.push(`${file.name} (${reason})`);
  }

  if (malformed.length === 0) {
    return {
      name: 'team-agent-markers',
      status: 'pass',
      // Name the regen command even on pass so the operator knows what
      // maintains the generated region: `scrum team sync-agents`.
      message: `${files.length} team-agent file(s) carry a well-formed generated region (regen via \`scrum team sync-agents\`)`,
    };
  }
  return {
    name: 'team-agent-markers',
    status: 'fail',
    message: `malformed generated region: ${malformed.join(', ')}`,
    fix: SYNC_AGENTS_FIX,
  };
}

/**
 * Return a short defect description when the generated region is malformed, or
 * `undefined` when it is well-formed (exactly one BEGIN, exactly one END, BEGIN
 * before END). Counts occurrences so a duplicated or nested marker is caught,
 * not just an absent one.
 */
function markerDefect(content: string): string | undefined {
  const begins = countOccurrences(content, TEAM_AGENT_BEGIN_MARKER);
  const ends = countOccurrences(content, TEAM_AGENT_END_MARKER);
  if (begins === 0 && ends === 0) return 'no generated markers';
  if (begins === 0) return 'missing BEGIN marker';
  if (ends === 0) return 'missing END marker';
  if (begins > 1) return 'duplicate BEGIN marker';
  if (ends > 1) return 'duplicate END marker';
  if (content.indexOf(TEAM_AGENT_BEGIN_MARKER) > content.indexOf(TEAM_AGENT_END_MARKER)) {
    return 'END marker precedes BEGIN marker';
  }
  return undefined;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return count;
    count++;
    from = idx + needle.length;
  }
}

/**
 * Reconcile the on-disk team-agent files against the scrum team registry. Two
 * drift classes fail:
 *
 *   - an `active` team is missing one of its three role files (a seat the
 *     committed agents never materialized);
 *   - a `team-<slug>-<role>.md` file survives for a slug the registry does not
 *     know, or whose team is no longer active (a stale seat termination should
 *     have deleted).
 *
 * Report-only — the named repair is `scrum team sync-agents` (which both
 * backfills missing files and is the command termination forgot to follow).
 * Skips cleanly when the scrum store is absent (`.prove/prove.db` missing):
 * doctor is a non-invasive diagnostic and never creates the store just to read
 * it. The store is opened against `cwd` (the real project root doctor runs in),
 * never a worktree sharing the live db.
 */
async function checkTeamAgentRegistryDrift(cwd: string): Promise<CheckResult | undefined> {
  const files = discoverTeamAgentFiles(cwd);
  const storePath = join(cwd, PROVE_DB_REL);
  // No store means no registry to reconcile against. When agent files exist
  // without any store, that is itself drift worth surfacing; with neither,
  // there is nothing to check.
  if (!existsSync(storePath)) {
    if (files && files.length > 0) {
      return {
        name: 'team-agent-drift',
        status: 'warn',
        message: `${files.length} team-agent file(s) present but no scrum store at ${PROVE_DB_REL} to reconcile against`,
        fix: SYNC_AGENTS_FIX,
      };
    }
    return undefined;
  }

  let teams: Team[];
  try {
    const store = await openScrumStore({ override: storePath });
    try {
      // Await the read before the sync close so no pending prepared statement
      // runs after the connection finalizes.
      teams = await store.listTeams();
    } finally {
      store.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'team-agent-drift',
      status: 'warn',
      message: `could not read team registry: ${msg}`,
      fix: 'inspect `.prove/prove.db` or run `claude-prove store info`',
    };
  }

  const activeSlugs = new Set(teams.filter((t) => t.status === 'active').map((t) => t.slug));
  const knownActive = (slug: string): boolean => activeSlugs.has(slug);
  const onDisk = files ?? [];

  // Missing: an active team lacking one of its three role files.
  const missing: string[] = [];
  for (const slug of activeSlugs) {
    for (const role of TEAM_ROLES) {
      const present = onDisk.some((f) => f.slug === slug && f.role === role);
      if (!present) missing.push(`team-${slug}-${role}.md`);
    }
  }

  // Orphans: a role file for a slug the registry does not know as active.
  const orphans = onDisk.filter((f) => !knownActive(f.slug)).map((f) => f.name);

  if (missing.length === 0 && orphans.length === 0) {
    return {
      name: 'team-agent-drift',
      status: 'pass',
      message: `${activeSlugs.size} active team(s) reconcile with their on-disk role files`,
    };
  }

  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
  if (orphans.length > 0) parts.push(`orphaned ${orphans.join(', ')}`);
  return {
    name: 'team-agent-drift',
    status: 'fail',
    message: `team-agent drift: ${parts.join('; ')}`,
    fix: SYNC_AGENTS_FIX,
  };
}

// ---------------------------------------------------------------------------
// Per-machine plugin-dir resolution (mirrors the hooks' shell expansion)
// ---------------------------------------------------------------------------

interface LocalPluginDir {
  dir: string;
  /** Where the value came from, for actionable doctor messages. */
  source: 'process-env' | 'settings.local.json' | 'default';
}

/**
 * Resolve `$CLAUDE_PROVE_PLUGIN_DIR` the way a fired hook sees it.
 *
 * Inside a Claude Code session the `env` block of settings.local.json is
 * injected into the process environment, so checking the process env first
 * matches the session view; reading the file second keeps doctor accurate
 * when run from a plain shell where no injection happened.
 */
function resolveLocalPluginDir(cwd: string): LocalPluginDir {
  const fromEnv = process.env[PLUGIN_DIR_ENV_VAR];
  if (fromEnv && fromEnv.length > 0) {
    return { dir: fromEnv, source: 'process-env' };
  }
  const fromLocal = readLocalSettingsPluginDir(cwd);
  if (fromLocal) {
    return { dir: fromLocal, source: 'settings.local.json' };
  }
  return { dir: DEFAULT_PLUGIN_INSTALL, source: 'default' };
}

/** Read `env.CLAUDE_PROVE_PLUGIN_DIR` from `.claude/settings.local.json`, if any. */
function readLocalSettingsPluginDir(cwd: string): string | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(cwd, DEFAULT_LOCAL_SETTINGS_REL), 'utf8'),
    ) as Record<string, unknown>;
    const env = parsed.env;
    if (env && typeof env === 'object') {
      const value = (env as Record<string, unknown>)[PLUGIN_DIR_ENV_VAR];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  } catch {
    // absent or malformed — both mean "no local override"
  }
  return undefined;
}

/** True when any prove-owned hook command uses the interpolated form. */
function settingsUseInterpolation(cwd: string): boolean {
  try {
    return readFileSync(join(cwd, DEFAULT_SETTINGS_REL), 'utf8').includes(INTERPOLATION_MARKER);
  } catch {
    return false;
  }
}

/**
 * Verify the resolved plugin dir can serve the hooks' dev entry point. A miss
 * means every interpolated hook fails at fire time — the per-machine setup
 * (`install local-env`) has not been run on this machine.
 */
function checkPluginDirEnv(local: LocalPluginDir): CheckResult {
  const entry = join(local.dir, DEV_ENTRY_REL);
  if (existsSync(entry)) {
    return {
      name: 'plugin-dir-env',
      status: 'pass',
      message: `${local.dir} (via ${local.source})`,
    };
  }
  return {
    name: 'plugin-dir-env',
    status: 'fail',
    message: `hooks expand to ${local.dir} (via ${local.source}) but ${DEV_ENTRY_REL} is missing there`,
    fix: 'run `claude-prove install local-env --plugin-dir <your-checkout>` (writes the env block in .claude/settings.local.json), then restart the Claude Code session',
  };
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
      fix: 'set $CLAUDE_PROVE_PLUGIN_DIR (via `claude-prove install local-env`) or $CLAUDE_PLUGIN_ROOT to your plugin checkout, or reinstall the plugin',
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

/** Per-block path results plus the distinct verified targets for the exec probe. */
interface HookPathsAudit {
  results: CheckResult[];
  targets: HookTarget[];
}

/**
 * For every prove-owned hook block in `.claude/settings.json`, verify the
 * command prefix points at something executable. Returns one result per
 * block (or a single informational result when the file is absent), plus
 * the deduplicated set of verified targets so `checkHookExec` can probe
 * each distinct command once instead of once per block.
 */
function checkSettingsHookPaths(cwd: string, localPluginDir: string): HookPathsAudit {
  const path = join(cwd, DEFAULT_SETTINGS_REL);
  if (!existsSync(path)) {
    return {
      results: [
        {
          name: 'hook-paths',
          status: 'warn',
          message: `no ${DEFAULT_SETTINGS_REL} at ${cwd}`,
          fix: 'run `claude-prove install init` to scaffold hook blocks',
        },
      ],
      targets: [],
    };
  }

  let settings: SettingsFile;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8')) as SettingsFile;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      results: [
        {
          name: 'hook-paths',
          status: 'fail',
          message: `failed to parse ${path}: ${msg}`,
          fix: 'fix the JSON syntax or run `claude-prove install init --force`',
        },
      ],
      targets: [],
    };
  }

  const proveBlocks = collectProveBlocks(settings);
  if (proveBlocks.length === 0) {
    return {
      results: [
        {
          name: 'hook-paths',
          status: 'warn',
          message: `no prove-owned hook blocks in ${DEFAULT_SETTINGS_REL}`,
          fix: 'run `claude-prove install init` to scaffold hook blocks',
        },
      ],
      targets: [],
    };
  }

  const results: CheckResult[] = [];
  const targets = new Map<string, HookTarget>();
  for (const block of proveBlocks) {
    const audit = checkHookBlock(block, localPluginDir);
    results.push(audit.result);
    // Probe only targets whose path verification passed — exec on a missing
    // path would just duplicate the hook-paths failure.
    if (audit.result.status !== 'fail') {
      for (const target of audit.targets) {
        targets.set(`${target.kind}:${target.path}`, target);
      }
    }
  }
  return { results, targets: [...targets.values()] };
}

/**
 * Extract every hook block tagged with `_tool` (prove-owned). User-authored
 * blocks without `_tool` are skipped — we never audit them.
 *
 * Guards against non-array and non-object values because settings.json is
 * user-editable and a malformed hook-event value (e.g. a number) would
 * cause an uncaught TypeError from `for...of` — exactly the wrong failure
 * mode when the user is already running doctor to diagnose a suspect file.
 */
function collectProveBlocks(settings: SettingsFile): HookBlock[] {
  const result: HookBlock[] = [];
  const hooks = settings.hooks ?? {};
  for (const blocks of Object.values(hooks)) {
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (
        block &&
        typeof block === 'object' &&
        typeof (block as Record<string, unknown>)._tool === 'string'
      ) {
        result.push(block as HookBlock);
      }
    }
  }
  return result;
}

/**
 * Validate a single prove-owned hook block.
 *
 * Three command shapes are in use:
 *   1. `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-...}/.../run.ts" <sub>` — portable dev
 *   2. `bun run <abs-path-to-run.ts> <subcommand>` — pre-portable dev (drift)
 *   3. `<path-to-binary> <subcommand>`             — compiled
 *
 * Interpolated tokens are expanded the way the firing shell would (using the
 * resolved per-machine plugin dir) before verification. For script targets we
 * stat the file; for binaries we require X_OK. A verified block that still
 * carries a machine-absolute dev prefix (shape 2) warns: it works on the
 * machine that generated it but breaks for every other contributor.
 *
 * Iterates every entry in `block.hooks` — multi-entry blocks must not be
 * silently passed based solely on entry[0]. First failure wins; a block
 * with zero entries fails with an empty-block message.
 */
function checkHookBlock(
  block: HookBlock,
  localPluginDir: string,
): { result: CheckResult; targets: HookTarget[] } {
  const tool = block._tool ?? '<unknown>';
  const name = `hook-paths[${tool}:${block.matcher}]`;
  const fail = (result: CheckResult) => ({ result, targets: [] });

  if (block.hooks.length === 0) {
    return fail({
      name,
      status: 'fail',
      message: 'hook block has no entries',
      fix: 'run `claude-prove install init --force`',
    });
  }

  const targets: HookTarget[] = [];
  const verifiedPaths: string[] = [];
  let bakedAbsolutePrefix = false;
  for (const entry of block.hooks) {
    if (!entry || typeof entry.command !== 'string') {
      return fail({
        name,
        status: 'fail',
        message: 'hook block has no command',
        fix: 'run `claude-prove install init --force`',
      });
    }

    const tokens = entry.command.trim().split(/\s+/);
    const target = extractHookTarget(tokens, localPluginDir);
    if (!target) {
      return fail({
        name,
        status: 'fail',
        message: `could not parse hook command: ${entry.command}`,
        fix: 'run `claude-prove install init --force`',
      });
    }

    const verdict = verifyHookTarget(target);
    if (verdict.status !== 'pass') {
      const interpolated = entry.command.includes(INTERPOLATION_MARKER);
      return fail({
        name,
        status: 'fail',
        message: verdict.message,
        // A target-specific fix (e.g. a $PATH miss) beats the generic regen
        // advice — `install init --force` on a misdetected machine can
        // replace working hook commands with a broken form.
        fix:
          verdict.fix ??
          (interpolated
            ? 'run `claude-prove install local-env --plugin-dir <your-checkout>`, then restart the session'
            : 'run `claude-prove install init --force`'),
      });
    }
    targets.push(target);
    verifiedPaths.push(target.path);

    // A dev-entry script addressed by a literal absolute path is the
    // pre-portable emission: valid here, broken on every other machine.
    if (
      target.kind === 'script' &&
      !entry.command.includes(INTERPOLATION_MARKER) &&
      entry.command.includes(DEV_ENTRY_REL)
    ) {
      bakedAbsolutePrefix = true;
    }
  }

  if (bakedAbsolutePrefix) {
    return {
      result: {
        name,
        status: 'warn',
        message: `machine-absolute dev prefix (pre-portable format): ${verifiedPaths.join(', ')}`,
        fix: 'run `claude-prove install init-hooks --force` to regenerate portable hook commands',
      },
      targets,
    };
  }

  return { result: { name, status: 'pass', message: verifiedPaths.join(', ') }, targets };
}

interface HookTarget {
  /** 'script' for `bun run <path>`, 'binary' for a direct executable. */
  kind: 'script' | 'binary';
  path: string;
}

/**
 * Expand a hook-command token the way the firing shell would: strip quotes,
 * substitute `${CLAUDE_PROVE_PLUGIN_DIR:-default}` with the resolved
 * per-machine dir, and expand `$HOME`/`${HOME}`. The `${VAR:-default}`
 * substitution must run before `$HOME` expansion because the default itself
 * contains `$HOME`.
 */
function expandHookToken(token: string, localPluginDir: string): string {
  let expanded = token.replace(/^"+|"+$/g, '');
  expanded = expanded.replace(
    new RegExp(`\\$\\{${PLUGIN_DIR_ENV_VAR}:-[^}]*\\}`, 'g'),
    localPluginDir,
  );
  expanded = expanded.replace(/\$\{HOME\}|\$HOME\b/g, homedir());
  return expanded;
}

function extractHookTarget(tokens: string[], localPluginDir: string): HookTarget | undefined {
  const first = tokens[0];
  if (!first) return undefined;
  if (first === 'bun') {
    // Find the first positional after `run` that isn't a flag.
    const runIdx = tokens.indexOf('run');
    if (runIdx < 0) return undefined;
    for (let i = runIdx + 1; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok && !tok.startsWith('-')) {
        return { kind: 'script', path: expandHookToken(tok, localPluginDir) };
      }
    }
    return undefined;
  }
  return { kind: 'binary', path: expandHookToken(first, localPluginDir) };
}

function verifyHookTarget(target: HookTarget): {
  status: 'pass' | 'fail';
  message: string;
  fix?: string;
} {
  try {
    if (target.kind === 'script') {
      const stat = statSync(target.path);
      if (!stat.isFile()) {
        return { status: 'fail', message: `hook script is not a regular file: ${target.path}` };
      }
      return { status: 'pass', message: target.path };
    }
    // A bare command (no path separator) is the documented portable form —
    // the firing shell resolves it on $PATH, so doctor must too. accessSync
    // on the raw token would probe cwd-relative and false-fail every bare
    // `claude-prove` hook.
    if (!target.path.includes('/')) {
      const resolved = which(target.path);
      if (resolved) return { status: 'pass', message: `${target.path} → ${resolved}` };
      return {
        status: 'fail',
        message: `hook command not found on $PATH: ${target.path}`,
        fix: 'install the binary (`claude-prove install upgrade`) or add its directory to PATH',
      };
    }
    accessSync(target.path, constants.X_OK);
    return { status: 'pass', message: target.path };
  } catch {
    return { status: 'fail', message: `hook target missing or not executable: ${target.path}` };
  }
}

/** Upper bound on one `--version` probe — a cold `bun run` can take seconds. */
const HOOK_EXEC_TIMEOUT_MS = 20_000;

/**
 * Execute each distinct hook target once with `--version` and verify it
 * exits 0. Path existence (hook-paths) is necessary but not sufficient: a
 * `bun run` wrapper against a marketplace clone resolves to a real file yet
 * dies on module resolution at fire time, leaving every scaffolded hook
 * failing silently inside its timeout. This probe is the check that catches
 * that class of breakage.
 */
function checkHookExec(targets: HookTarget[]): CheckResult[] {
  return targets.map((target) => {
    const argv =
      target.kind === 'script'
        ? ['bun', 'run', target.path, '--version']
        : [target.path, '--version'];
    const name = `hook-exec[${target.kind}]`;
    const fix =
      target.kind === 'script'
        ? 'run `bun install` in the checkout, or set `"dev_mode": false` in .claude/.prove.json and re-run `claude-prove install init-hooks --force` to emit binary invocations'
        : 'reinstall the binary (`claude-prove install upgrade`), then re-run `claude-prove install init-hooks --force`';

    try {
      const proc = Bun.spawnSync({
        cmd: argv,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: HOOK_EXEC_TIMEOUT_MS,
      });
      if (proc.exitCode === 0) {
        const version = proc.stdout.toString().trim().split('\n')[0] ?? '';
        return { name, status: 'pass' as const, message: `${argv.join(' ')} → ${version}` };
      }
      const stderrLine = proc.stderr.toString().trim().split('\n')[0] ?? '';
      return {
        name,
        status: 'fail' as const,
        message: `${argv.join(' ')} exited ${proc.exitCode}${stderrLine ? `: ${stderrLine}` : ''}`,
        fix,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        name,
        status: 'fail' as const,
        message: `${argv.join(' ')} failed to spawn: ${msg}`,
        fix,
      };
    }
  });
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
