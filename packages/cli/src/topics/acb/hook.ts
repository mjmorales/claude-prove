/**
 * Claude Code PostToolUse hook for ACB intent capture.
 *
 * Fires AFTER every successful `git commit` Bash call. Resolves the
 * resulting commit SHA, checks the main-worktree ACB store (unified
 * `prove.db`, acb domain) for a manifest keyed to that SHA, and — if none
 * exists — blocks the agent with a `decision: "block"` JSON response that
 * prompts it to run `claude-prove acb save-manifest` for the real SHA.
 *
 * Design notes:
 *
 *   - No PreToolUse. Manifests describe what actually landed, so
 *     blocking before the commit risks stale manifests with SHAs that
 *     never existed.
 *   - Writes always land in the main worktree's `.prove/prove.db`
 *     (passed as `workspaceRoot`) so linked worktrees do not fragment
 *     the store.
 *   - Exit code is always 0. Claude Code treats `{decision:"block"}`
 *     JSON on stdout as the block signal; exit is not the channel.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { DEV_INVOCATION_PREFIX } from '@claude-prove/installer';
import { currentBranch, headSha, resolveRunSlug } from '@claude-prove/shared';
import { openAcbStore } from './store';
import { isoSeconds } from './time';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Claude Code PostToolUse hook stdin payload (Bash matcher). */
export interface ClaudeCodeHookPayload {
  tool_name?: string;
  tool_input?: { command?: string };
  /** Shape varies across Claude Code versions; narrowed dynamically. */
  tool_response?: unknown;
  cwd?: string;
}

/** `{decision:"block", reason}` returned on stdout to Claude Code. */
export interface HookDecision {
  decision?: 'block';
  reason?: string;
}

/** Result of `runHookPostCommit` — caller writes stdout and exits. */
export interface HookOutput {
  /** JSON-encoded `HookDecision` or empty string for silent pass. */
  stdout: string;
  /** Always 0 — stdout is the control channel. */
  exit: number;
}

/** Template parameters for `generateManifestPrompt`. */
export interface ManifestPromptParams {
  branch: string;
  sha: string;
  shortSha: string;
  diffStat: string;
  slugClause: string;
  slugFlag: string;
  workspaceRoot: string;
  nowIso: string;
  /**
   * When true, the emitted save-manifest invocation uses the shell-
   * interpolated `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-...}/packages/cli/bin/run.ts"`
   * prefix so plugin developers execute the working-tree code their machine's
   * env var points at — no machine-absolute path lands in the prompt. When
   * false (default for installed users), emits bare `claude-prove` and relies
   * on the CLI being on PATH. Sourced from `<workspaceRoot>/.claude/.prove.json`'s
   * top-level `dev_mode` field via `readDevMode`.
   */
  devMode: boolean;
}

// ---------------------------------------------------------------------------
// Constants (mirror Python _COMMIT_RE, _SKIP_BRANCHES, _CD_RE)
// ---------------------------------------------------------------------------

/** Matches any `git commit` word-bounded occurrence in a command. */
const COMMIT_RE = /\bgit\s+commit\b/;

/** Branches that never receive manifests (manifests land on feature branches). */
const SKIP_BRANCHES = new Set(['main', 'master']);

/**
 * Orchestrator-managed branch prefixes. A missing run_slug on these prefixes
 * indicates a worktree created outside `claude-prove worktree`; the hook refuses
 * to proceed rather than producing orphan manifests.
 */
const ORCHESTRATOR_BRANCH_PREFIXES = ['orchestrator/', 'task/'] as const;

/**
 * Matches `cd PATH` at the start of the command or after a separator
 * (`;`, `&&`, `|`, `(`, `)`, newline). PATH can be unquoted, double-quoted,
 * or single-quoted. Subshells like `(cd X && git commit)` match because `(`
 * counts as a leading separator.
 *
 * Equivalent to Python's `_CD_RE`:
 *   r'(?:^|[;&|()\n])\s*cd\s+(?P<path>"[^"]*"|\'[^\']*\'|[^\s;&|()]+)'
 */
const CD_RE = /(?:^|[;&|()\n])\s*cd\s+(?<path>"[^"]*"|'[^']*'|[^\s;&|()]+)/g;

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Process a PostToolUse payload. Pure — no stdout/stdin side effects so the
 * CLI handler can drive I/O and tests can assert return shape.
 */
export async function runHookPostCommit(opts: {
  workspaceRoot: string;
  payload: ClaudeCodeHookPayload;
}): Promise<HookOutput> {
  const { workspaceRoot, payload } = opts;

  // Filter 1: only Bash tool invocations carry git commands.
  if (payload.tool_name !== 'Bash') return silent();

  const command = payload.tool_input?.command ?? '';
  if (!COMMIT_RE.test(command)) return silent();

  if (!commitSucceeded(payload.tool_response)) return silent();

  // Parse `.claude/.prove.json` once; the enabled-toggle check and the later
  // dev-mode read both consult this single parse.
  const proveConfig = readProveConfig(workspaceRoot);

  // Respect the `tools.acb.enabled` toggle in `.claude/.prove.json`. Defense in
  // depth alongside the installer, which omits the acb hook block when the tool
  // is disabled — a settings.json staged while acb was enabled would otherwise
  // keep firing this hook.
  if (!acbEnabledFrom(proveConfig)) return silent();

  // Subagents run `cd <worktree> && git commit` because shell state doesn't
  // persist across Bash calls. Read HEAD from the cd target so the right
  // worktree is inspected.
  const sessionCwd = payload.cwd ?? process.cwd();
  const cwd = parseEffectiveCwd(command, sessionCwd);

  const branch = currentBranch(cwd);
  if (branch === null || SKIP_BRANCHES.has(branch)) return silent();

  const sha = headSha(cwd);
  if (sha === null) return silent();

  const runSlug = resolveRunSlug(cwd);

  // Orchestrator-managed worktrees must carry a slug. Missing slug on these
  // prefixes means the worktree was created outside the managed path.
  if (runSlug === null && ORCHESTRATOR_BRANCH_PREFIXES.some((p) => branch.startsWith(p))) {
    return block(orchestratorSlugGuardReason(branch));
  }

  // Check store for an existing manifest. When `runSlug` is non-null, only
  // manifests tagged with that slug count.
  if (await manifestExists(workspaceRoot, sha, runSlug)) return silent();

  const diffStat = headDiffStat(sha, cwd);
  const nowIso = isoSeconds();
  const devMode = devModeFrom(proveConfig);

  const reason = generateManifestPrompt({
    branch,
    sha,
    shortSha: sha.slice(0, 12),
    diffStat: diffStat.length > 0 ? diffStat : '(no diff stat available)',
    slugClause: runSlug !== null ? ` (run \`${runSlug}\`)` : '',
    slugFlag: runSlug !== null ? ` --slug ${runSlug}` : '',
    workspaceRoot,
    nowIso,
    devMode,
  });

  return block(reason);
}

// ---------------------------------------------------------------------------
// Sub-utilities (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Resolve the cwd the commit actually ran in.
 *
 * Walks `CD_RE` matches across `command`; picks the LAST `cd` whose match
 * starts before the first `git commit` occurrence. Strips matching quote
 * pairs. Unresolvable paths (containing `$`, backtick, or `~`) are skipped.
 * Relative paths are joined against `fallback`. A resolved path that is not
 * an existing directory returns `fallback`.
 */
export function parseEffectiveCwd(command: string, fallback: string): string {
  const commitPos = command.indexOf('git commit');
  if (commitPos < 0) return fallback;

  let lastCd: string | null = null;
  CD_RE.lastIndex = 0;
  for (const match of command.matchAll(CD_RE)) {
    if (match.index === undefined || match.index >= commitPos) continue;
    let path = match.groups?.path ?? '';
    if (path.length >= 2) {
      const first = path.charAt(0);
      if ((first === '"' || first === "'") && path.endsWith(first)) {
        path = path.slice(1, -1);
      }
    }
    // Unresolvable expansions — give up rather than guess.
    if (path.includes('$') || path.includes('`') || path.includes('~')) continue;
    lastCd = path;
  }

  if (lastCd === null) return fallback;

  let resolved = lastCd;
  if (!isAbsolute(resolved)) {
    resolved = normalize(join(fallback, resolved));
  }
  return isDir(resolved) ? resolved : fallback;
}

/**
 * Best-effort check that the Bash commit call did not error out.
 *
 * Claude Code's PostToolUse `tool_response` shape is not standardized across
 * versions — non-object payloads are treated as success (no error signal
 * means assume success). Any of `is_error` / `isError` truthy, or an integer
 * `exit_code` / `exitCode` != 0, marks failure.
 */
export function commitSucceeded(toolResponse: unknown): boolean {
  if (toolResponse === null || typeof toolResponse !== 'object' || Array.isArray(toolResponse)) {
    return true;
  }
  const obj = toolResponse as Record<string, unknown>;
  if (obj.is_error === true) return false;
  if (obj.isError === true) return false;
  const code = obj.exit_code ?? obj.exitCode;
  if (typeof code === 'number' && Number.isInteger(code) && code !== 0) return false;
  return true;
}

/**
 * Build the MANIFEST_PROMPT body. The save-manifest invocation line branches
 * on `dev_mode` (bare `claude-prove` vs `bun run …`); see the body comment.
 */
export function generateManifestPrompt(params: ManifestPromptParams): string {
  const { branch, sha, shortSha, diffStat, slugClause, slugFlag, workspaceRoot, nowIso, devMode } =
    params;

  // The save-manifest invocation prefix branches on the project's
  // `.claude/.prove.json::dev_mode`. Installed users (default) get the bare
  // `claude-prove` on PATH; plugin developers get the shell-interpolated
  // working-tree form — `$CLAUDE_PROVE_PLUGIN_DIR` expands when the agent
  // runs the command, so the prompt carries no machine-absolute path.
  const invocation = devMode ? `${DEV_INVOCATION_PREFIX} acb` : 'claude-prove acb';

  // Template body is byte-frozen: every character outside substitutions —
  // including the em-dashes, the `∈` glyph, and the closing sentence — must
  // stay exact so golden-fixture parity holds.
  return `ACTION REQUIRED — commit ${shortSha} on \`${branch}\`${slugClause} has no intent manifest. Your next tool call MUST be this exact Bash invocation (no variations, no prefix commands):

\`\`\`bash
${invocation} save-manifest --workspace-root ${workspaceRoot} --branch ${branch} --sha ${sha}${slugFlag} <<'MANIFEST'
{
  "acb_manifest_version": "0.2",
  "commit_sha": "${sha}",
  "timestamp": "${nowIso}",
  "intent_groups": [
    {
      "id": "<slug-for-this-group>",
      "title": "<what-this-group-does>",
      "classification": "explicit",
      "file_refs": [
        {"path": "<path/to/file>", "ranges": ["<start>-<end>"]}
      ],
      "annotations": [
        {"id": "ann-1", "type": "judgment_call", "body": "<why-if-non-obvious>"}
      ]
    }
  ]
}
MANIFEST
\`\`\`

Rules for filling in \`intent_groups\` (everything else above is fixed — do NOT edit the flags or JSON keys):
1. One group per logical unit of change. Group related file edits together.
2. Every file in the diff below MUST appear in at least one group's \`file_refs\`.
3. \`classification\` ∈ \`explicit\` (user asked for it), \`inferred\` (logically required), \`speculative\` (beyond asked).
4. \`ranges\` is optional — omit for whole-file changes; use \`"<start>-<end>"\` for partial.
5. Add a \`judgment_call\` annotation only for non-obvious decisions; omit \`annotations\` entirely if none.

Diff for ${shortSha}:
\`\`\`
${diffStat}
\`\`\`

Do not run any other command until the manifest is saved. The hook will re-fire on the next commit for its own SHA.`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function silent(): HookOutput {
  return { stdout: '', exit: 0 };
}

function block(reason: string): HookOutput {
  const payload: HookDecision = { decision: 'block', reason };
  return { stdout: JSON.stringify(payload), exit: 0 };
}

/**
 * Check the unified store for a manifest keyed to `commitSha`. Returns `true`
 * when a manifest exists (commit passes silently); returns `false` otherwise.
 *
 * Errors (missing db, migration failure) coerce to `false`, which routes the
 * commit into the block-and-ask-for-manifest path — the conservative default.
 * A store problem therefore never silently lets an unmanifested commit pass;
 * it forces the agent to save a manifest instead.
 *
 * The catch emits a warn so an operator can distinguish a genuine missing
 * manifest from a corrupt/inaccessible store when every commit is being
 * intercepted.
 */
async function manifestExists(
  workspaceRoot: string,
  commitSha: string,
  runSlug: string | null,
): Promise<boolean> {
  try {
    const dbPath = join(workspaceRoot, '.prove', 'prove.db');
    const store = await openAcbStore({ override: dbPath });
    try {
      return await store.hasManifestForSha(commitSha, runSlug ?? undefined);
    } finally {
      store.close();
    }
  } catch (err) {
    console.warn('claude-prove acb hook: manifestExists failed, proceeding without manifest:', err);
    return false;
  }
}

function headDiffStat(sha: string, cwd: string): string {
  try {
    const proc = Bun.spawnSync({
      cmd: ['git', 'show', '--stat', '--format=', sha],
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (proc.exitCode !== 0) return '';
    return (proc.stdout?.toString() ?? '').trim();
  } catch {
    return '';
  }
}

function orchestratorSlugGuardReason(branch: string): string {
  return `ACB: branch \`${branch}\` looks orchestrator-managed but no run slug resolved. Expected .prove-wt-slug.txt in this worktree or PROVE_RUN_SLUG env var. Run \`claude-prove worktree create <slug> <task-id>\` to create the worktree, or write the marker manually.`;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Parse `.claude/.prove.json` under `workspaceRoot` into a plain object, or
 * `null` when the file is absent, unparseable, or not a JSON object. The single
 * parse `runHookPostCommit` reads both the `dev_mode` and `tools.acb.enabled`
 * flags from, so one fire does not stat/parse the config twice.
 */
function readProveConfig(workspaceRoot: string): Record<string, unknown> | null {
  const configPath = join(workspaceRoot, '.claude', '.prove.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Whether `dev_mode` is enabled in a parsed config. Defaults to `false`
 * (installed-binary mode) for a `null` config or a missing/non-boolean field.
 */
function devModeFrom(config: Record<string, unknown> | null): boolean {
  return config?.dev_mode === true;
}

/**
 * Whether the acb tool is enabled in a parsed config. Defaults to `true`
 * (fire-by-default) for a `null` config or an absent block; only an explicit
 * `tools.acb.enabled: false` disables it.
 */
function acbEnabledFrom(config: Record<string, unknown> | null): boolean {
  if (config === null) return true;
  const tools = config.tools;
  if (typeof tools !== 'object' || tools === null) return true;
  const acb = (tools as Record<string, unknown>).acb;
  if (typeof acb !== 'object' || acb === null) return true;
  return (acb as Record<string, unknown>).enabled !== false;
}

/**
 * Read `.claude/.prove.json::dev_mode` under `workspaceRoot`. Returns `false`
 * when the file is absent, unparseable, or when `dev_mode` is missing/not a
 * boolean — installed-binary mode is the default.
 *
 * The hook reads this at fire time (no scan cache) because the manifest
 * prompt must reflect the live config — users may flip dev_mode mid-session
 * when switching between a dev checkout and an installed binary.
 */
export function readDevMode(workspaceRoot: string): boolean {
  return devModeFrom(readProveConfig(workspaceRoot));
}

/**
 * Read `.claude/.prove.json::tools.acb.enabled` under `workspaceRoot`. Returns
 * `true` (enabled) when the field is absent or the config is missing/malformed,
 * so the hook keeps its fire-by-default behavior; only an explicit
 * `enabled: false` disables it.
 */
export function acbEnabled(workspaceRoot: string): boolean {
  return acbEnabledFrom(readProveConfig(workspaceRoot));
}
