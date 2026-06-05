/**
 * CLAUDE.md composer — assembles scan results into an LLM-optimized CLAUDE.md.
 *
 * Ports `skills/claude-md/composer.py` 1:1 so the generated file is byte-equal
 * across the Python and TS implementations — preserves section ordering,
 * indentation, managed-block sentinels, and the exact `/prove:...` command
 * descriptions the Python reference emits.
 *
 * The managed block (between `MANAGED_START` and `MANAGED_END` markers) is
 * owned by prove and can be safely regenerated. Content outside the markers
 * is user-owned and preserved across updates via `replaceManagedBlock`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { DEV_INVOCATION_PREFIX, PROJECT_LINK_REL } from '@claude-prove/installer';
import type {
  CoreCommand,
  ReferenceEntry,
  ScanResult,
  TeamAgentSummary,
  ToolDirective,
  ValidatorSummary,
} from './scanner';

export const MANAGED_START = '<!-- prove:managed:start -->';
export const MANAGED_END = '<!-- prove:managed:end -->';

/**
 * Plugin-level default references injected whenever prove is configured.
 * Rendered before user-configured references (primacy). Deduped by path.
 */
export const PLUGIN_DEFAULT_REFERENCES: ReadonlyArray<ReferenceEntry> = [
  {
    path: '$PLUGIN_DIR/references/claude-prove-reference.md',
    label: 'claude-prove CLI Reference',
  },
  {
    // Engine boundary, native primitives, forced bubble-up, append-only.
    path: '$PLUGIN_DIR/references/design-principles.md',
    label: 'Design Principles',
  },
  {
    // Task-cue -> subagent/skill/CLI delegation cheatsheet.
    path: '$PLUGIN_DIR/references/agent-routing.md',
    label: 'Agent Routing Map',
  },
];

/**
 * Compose CLAUDE.md from scan results.
 *
 * @param scan Output from {@link scanProject}.
 * @param _pluginDir Accepted for caller compatibility, unused: commands emit
 *   the env-interpolated prefix and plugin references emit the stable root —
 *   neither embeds a resolved plugin path.
 * @returns The full CLAUDE.md content as a single string (includes sentinels).
 */
export function compose(scan: ScanResult, _pluginDir?: string): string {
  const prove = scan.prove_config;
  const prefix = cliPrefix(prove.dev_mode);

  const parts: string[] = [];

  // Header
  parts.push(renderHeader(scan));

  // Plugin version check (always, if prove is configured)
  const pluginVersion = scan.plugin_version ?? 'unknown';
  if (prove.exists && pluginVersion !== 'unknown') {
    parts.push(renderVersionCheck(pluginVersion, prefix));
  }

  // Always include: tech-stack identity line
  parts.push(renderIdentity(scan));

  // Structure (if key dirs found)
  if (Object.keys(scan.key_dirs).length > 0) {
    parts.push(renderStructure(scan));
  }

  // Conventions (if naming detected)
  if (scan.conventions.naming && scan.conventions.naming !== 'unknown') {
    parts.push(renderConventions(scan));
  }

  // Validation (if .claude/.prove.json has validators)
  if (prove.validators.length > 0) {
    parts.push(renderValidation(scan));
  }

  // Discovery (if CAFI is available)
  if (scan.cafi.available || prove.has_index) {
    parts.push(renderDiscovery(prefix));
  }

  // Tool directives (from enabled tools)
  if (prove.tool_directives.length > 0) {
    parts.push(renderToolDirectives(prove.tool_directives));
  }

  // Team agents (if role-bound team agent files exist)
  if (scan.team_agents.length > 0) {
    parts.push(renderTeamAgents(scan.team_agents, prefix));
  }

  // References — plugin built-ins first, then user-configured (deduped by path)
  const mergedRefs = mergeReferences(prove.exists, prove.references);
  if (mergedRefs.length > 0) {
    parts.push(renderReferences(mergedRefs, scan.project_root ?? ''));
  }

  // Prove commands (if prove is configured)
  if (prove.exists) {
    parts.push(renderTools(scan.core_commands));
  }

  const body = `${parts.join('\n')}\n`;
  return `${MANAGED_START}\n${body}${MANAGED_END}\n`;
}

/**
 * Compose a compact discovery context block for injection into subagent prompts.
 * Subset of the full CLAUDE.md focused on discovery + validation.
 *
 * `_pluginDir` is accepted for caller compatibility but unused: dev mode
 * emits the shell-interpolated `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-...}/..."`
 * prefix that resolves per-machine at run time; installed users get bare
 * `claude-prove`.
 */
export function composeSubagentContext(scan: ScanResult, _pluginDir?: string): string {
  const prefix = cliPrefix(scan.prove_config.dev_mode);

  const parts: string[] = [];
  parts.push('## Project Context');
  parts.push('');

  const langs = scan.tech_stack.languages.join(', ') || 'unknown';
  parts.push(`**Stack**: ${langs}`);

  if (scan.cafi.available) {
    parts.push('');
    parts.push('**Discovery**: Before broad Glob/Grep searches, check the file index:');
    parts.push(`- \`${prefix} cafi context\` — full index with routing hints`);
    parts.push(`- \`${prefix} cafi get <path>\` — single file description`);
  }

  const validators = scan.prove_config.validators;
  if (validators.length > 0) {
    parts.push('');
    parts.push('**Validation**: Run before committing:');
    for (const v of validators) {
      parts.push(`- ${v.phase}: \`${describeValidator(v)}\``);
    }
  }

  parts.push('');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Section renderers — each returns the section text with a trailing '\n'
// ---------------------------------------------------------------------------

function renderHeader(scan: ScanResult): string {
  const name = scan.project?.name ?? 'Project';
  return `# ${name}\n`;
}

function renderVersionCheck(pluginVersion: string, prefix: string): string {
  const lines = [
    `<!-- prove:plugin-version:${pluginVersion} -->`,
    `**Prove plugin v${pluginVersion}** — if \`${prefix} --version\` does not ` +
      `match v${pluginVersion}, run \`/prove:update\` to sync.`,
    '',
  ];
  return lines.join('\n');
}

function renderIdentity(scan: ScanResult): string {
  const { languages, frameworks, build_systems: buildSystems } = scan.tech_stack;
  const stackParts: string[] = [];
  if (languages.length > 0) stackParts.push(languages.join(', '));
  if (frameworks.length > 0) stackParts.push(`+ ${frameworks.join(', ')}`);
  if (buildSystems.length > 0) stackParts.push(`(${buildSystems.join(', ')})`);

  const lines: string[] = [];
  if (stackParts.length > 0) lines.push(stackParts.join(' '));
  lines.push('');
  return lines.join('\n');
}

function renderStructure(scan: ScanResult): string {
  const lines: string[] = ['## Structure', ''];
  for (const [dirname, purpose] of Object.entries(scan.key_dirs)) {
    lines.push(`- \`${dirname}/\` — ${purpose}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderConventions(scan: ScanResult): string {
  const conv = scan.conventions;
  const lines: string[] = ['## Conventions', ''];

  if (conv.naming && conv.naming !== 'unknown') {
    lines.push(`- File naming: ${conv.naming}`);
  }

  if (conv.test_patterns.length > 0) {
    lines.push(`- Test files: ${conv.test_patterns.join(', ')}`);
  }

  lines.push('');
  return lines.join('\n');
}

function renderValidation(scan: ScanResult): string {
  const validators: ValidatorSummary[] = scan.prove_config.validators;
  const lines: string[] = ['## Validation', '', 'Run before committing:', ''];

  for (const v of validators) {
    lines.push(`- **${v.phase}**: \`${describeValidator(v)}\``);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Code-span content describing what a validator runs: the shell command, a
 * `prompt <path>` for an llm prompt validator, or a `skill <name>` for a
 * skill-invoked gate. Falls back to the validator name so a malformed entry
 * never renders an empty code span.
 */
function describeValidator(v: ValidatorSummary): string {
  if (v.command) return v.command;
  if (v.skill) return `skill ${v.skill}`;
  if (v.prompt) return `prompt ${v.prompt}`;
  return v.name;
}

function renderDiscovery(prefix: string): string {
  const lines = [
    '## Discovery Protocol',
    '',
    'Before broad Glob/Grep searches, check the file index first:',
    '',
    `- \`${prefix} cafi context\` — full index with routing hints`,
    `- \`${prefix} cafi lookup <keyword>\` — search by keyword`,
    '',
    "Only fall back to Glob/Grep when the index doesn't cover what you need.",
  ];
  return lines.join('\n');
}

function renderTools(coreCommands: CoreCommand[]): string {
  const lines: string[] = ['## Prove Commands', ''];
  if (coreCommands.length > 0) {
    for (const cmd of coreCommands) {
      lines.push(`- \`/prove:${cmd.name}\` — ${cmd.summary}`);
    }
  } else {
    lines.push('- `/prove:docs claude-md` — Regenerate this file');
  }
  lines.push('');
  return lines.join('\n');
}

function renderToolDirectives(toolDirectives: ToolDirective[]): string {
  const lines: string[] = ['## Tool Directives', ''];
  for (const td of toolDirectives) {
    lines.push(`### ${td.name}`);
    lines.push('');
    lines.push(td.directive);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Render the Team Agents section: the registered role-bound agents grouped by
 * team, plus the two dispatch directives — prefer a scope-matching team agent
 * over a general-purpose agent, and hold every dispatched team agent to its
 * memory protocol (bundle read before acting; annotation/Lore/Codex writes
 * through the scrum CLI). Input arrives pre-sorted from `scanTeamAgents`
 * (team-ascending, canonical role order), so grouping preserves that order.
 */
function renderTeamAgents(teamAgents: TeamAgentSummary[], prefix: string): string {
  const byTeam = new Map<string, string[]>();
  for (const agent of teamAgents) {
    const names = byTeam.get(agent.team) ?? [];
    names.push(agent.name);
    byTeam.set(agent.team, names);
  }

  const lines: string[] = ['## Team Agents', ''];
  lines.push('Role-bound team agents registered in `.claude/agents/`:');
  lines.push('');
  for (const [team, names] of byTeam) {
    lines.push(`- **${team}**: ${names.map((n) => `\`${n}\``).join(', ')}`);
  }
  lines.push('');
  lines.push('Dispatch and memory protocol:');
  lines.push('');
  lines.push(
    "- For subagent work that falls inside a team's scope, dispatch that team's role agent — " +
      "never a general-purpose agent. Resolve scope from each team's bundle `teams/<slug>.md`; " +
      "use a general-purpose agent only when no team's bundle scope covers the task.",
  );
  lines.push(
    '- Every dispatched team agent must honor its memory protocol: read its team bundle ' +
      '`teams/<slug>.md` (scope, roster, recent Lore) before acting, and record what it learns:',
  );
  lines.push(`  - seat notes with \`${prefix} scrum annotation add --target-kind team\``);
  lines.push(
    `  - team Lore with \`${prefix} scrum lore record\` (tech_lead seat; non-lead seats route journal-worthy findings to a seat annotation instead)`,
  );
  lines.push(`  - durable decisions with \`${prefix} scrum decision record\``);
  lines.push('');
  return lines.join('\n');
}

/**
 * Merge plugin built-ins with user-configured references.
 *
 * Built-ins come first (primacy positioning). A user entry with the same
 * resolved path as a built-in is dropped — the built-in label wins. Comparison
 * is on the raw path string (before `$PLUGIN_DIR` resolution) for safety; both
 * forms match because built-ins use the `$PLUGIN_DIR/...` form that survives
 * round-tripping through `/prove:update` feature-discovery.
 */
function mergeReferences(proveExists: boolean, userRefs: ReferenceEntry[]): ReferenceEntry[] {
  if (!proveExists) return userRefs;
  const builtInPaths = new Set(PLUGIN_DEFAULT_REFERENCES.map((r) => r.path));
  const deduped = userRefs.filter((r) => !builtInPaths.has(r.path));
  return [...PLUGIN_DEFAULT_REFERENCES, ...deduped];
}

/**
 * Derive the CLI invocation prefix for user-facing codegen.
 *
 * `devMode` is sourced from `.claude/.prove.json`'s top-level `dev_mode`
 * field (scanner lifts it into `scan.prove_config.dev_mode`). Plugin
 * developers running from a git checkout set `dev_mode: true` and get the
 * shell-interpolated `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-...}/..."` form —
 * the per-machine checkout path expands when the command runs, so the
 * generated (often git-tracked) file carries no machine-absolute path.
 * Installed users get the bare binary on PATH.
 */
function cliPrefix(devMode: boolean): string {
  return devMode ? DEV_INVOCATION_PREFIX : 'claude-prove';
}

/**
 * Make a configured reference path portable across contributor machines.
 *
 * The CLAUDE.md importer ONLY loads project-relative paths (env vars never
 * expand; `~/...` and absolute imports outside the project silently fail),
 * but it follows symlinks transparently. The filesystem therefore supplies
 * the per-machine variable:
 *
 *   - `$PLUGIN_DIR/...` entries (the plugin built-ins) hardcode the
 *     project-relative bridge `.claude/prove-plugin/...` — a gitignored
 *     symlink chain (`.claude/prove-plugin -> ~/.claude-prove/latest ->
 *     plugin dir`) maintained by `claude-md generate` and the `install`
 *     verbs. The emitted bytes are identical on every machine.
 *   - absolute paths inside the project emit project-relative;
 *   - absolute paths under the home dir emit the `~/...` form (best effort
 *     for user-authored entries that are home-anchored by design);
 *   - anything else passes through verbatim (already-relative user entries,
 *     `~/...` entries, or genuinely machine-local absolute paths).
 */
function portableRefPath(resolved: string, projectRoot: string): string {
  if (projectRoot.length > 0 && resolved.startsWith(projectRoot + sep)) {
    return resolved.slice(projectRoot.length + 1);
  }
  const home = homedir();
  if (resolved.startsWith(home + sep)) {
    return `~${resolved.slice(home.length)}`;
  }
  return resolved;
}

function renderReferences(references: ReferenceEntry[], projectRoot: string): string {
  const lines: string[] = ['## References', ''];
  for (const ref of references) {
    const label = ref.label;
    const path = ref.path;
    const resolved = path
      ? portableRefPath(path.replaceAll('$PLUGIN_DIR', PROJECT_LINK_REL), projectRoot)
      : '';
    if (label) {
      lines.push(`### ${label}`);
      lines.push('');
    }
    lines.push(`@${resolved}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// File write — preserves user content outside the managed block
// ---------------------------------------------------------------------------

/**
 * Write CLAUDE.md to the project root.
 *
 * If the file exists and contains the managed-block markers, only the managed
 * block is replaced — content above/below the markers is preserved. Otherwise
 * the entire file is written (first-time generation or file missing markers).
 *
 * @returns Absolute path to the written file.
 */
export function writeClaudeMd(projectRoot: string, content: string): string {
  const path = join(projectRoot, 'CLAUDE.md');

  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    const merged = replaceManagedBlock(existing, content);
    if (merged !== null) {
      writeFileSync(path, merged);
      return path;
    }
  }

  writeFileSync(path, content);
  return path;
}

/**
 * Replace the managed block in `existing` with `newBlock`.
 *
 * Returns the merged content, or `null` if the markers aren't found.
 */
export function replaceManagedBlock(existing: string, newBlock: string): string | null {
  const startIdx = existing.indexOf(MANAGED_START);
  const endIdx = existing.indexOf(MANAGED_END);
  if (startIdx === -1 || endIdx === -1) return null;

  // Include everything after the end marker line — find the newline following
  // the end marker; if none, splice at end-of-string.
  const trailing = existing.slice(endIdx);
  const nlOffset = trailing.indexOf('\n');
  const endOfMarker = nlOffset === -1 ? existing.length : endIdx + nlOffset + 1;

  const before = existing.slice(0, startIdx);
  const after = existing.slice(endOfMarker);
  return before + newBlock + after;
}
