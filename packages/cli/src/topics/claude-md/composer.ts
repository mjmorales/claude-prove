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
import { join } from 'node:path';
import type {
  CoreCommand,
  ReferenceEntry,
  ScanResult,
  ToolDirective,
  ValidatorSummary,
} from './scanner';

export const MANAGED_START = '<!-- prove:managed:start -->';
export const MANAGED_END = '<!-- prove:managed:end -->';

/**
 * Compose CLAUDE.md from scan results.
 *
 * @param scan Output from {@link scanProject}.
 * @param pluginDir Path to prove plugin. Falls back to `scan.plugin_dir`.
 * @returns The full CLAUDE.md content as a single string (includes sentinels).
 */
export function compose(scan: ScanResult, pluginDir?: string): string {
  const resolvedPluginDir = pluginDir ?? scan.plugin_dir ?? '';

  const parts: string[] = [];

  // Header
  parts.push(renderHeader(scan));

  // Plugin version check (always, if prove is configured)
  const pluginVersion = scan.plugin_version ?? 'unknown';
  const prove = scan.prove_config;
  if (prove.exists && pluginVersion !== 'unknown') {
    parts.push(renderVersionCheck(pluginVersion, resolvedPluginDir));
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
    parts.push(renderDiscovery(resolvedPluginDir));
  }

  // Tool directives (from enabled tools)
  if (prove.tool_directives.length > 0) {
    parts.push(renderToolDirectives(prove.tool_directives));
  }

  // External references
  if (prove.references.length > 0) {
    parts.push(renderReferences(prove.references, resolvedPluginDir));
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
 */
export function composeSubagentContext(scan: ScanResult, pluginDir?: string): string {
  const resolvedPluginDir = pluginDir ?? scan.plugin_dir ?? '';

  const parts: string[] = [];
  parts.push('## Project Context');
  parts.push('');

  const langs = scan.tech_stack.languages.join(', ') || 'unknown';
  parts.push(`**Stack**: ${langs}`);

  if (scan.cafi.available) {
    parts.push('');
    parts.push('**Discovery**: Before broad Glob/Grep searches, check the file index:');
    parts.push(
      `- \`bun run ${resolvedPluginDir}/packages/cli/bin/run.ts cafi context\` — full index with routing hints`,
    );
    parts.push(
      `- \`bun run ${resolvedPluginDir}/packages/cli/bin/run.ts cafi get <path>\` — single file description`,
    );
  }

  const validators = scan.prove_config.validators;
  if (validators.length > 0) {
    parts.push('');
    parts.push('**Validation**: Run before committing:');
    for (const v of validators) {
      parts.push(`- ${v.phase}: \`${v.command}\``);
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

function renderVersionCheck(pluginVersion: string, pluginDir: string): string {
  const lines = [
    `<!-- prove:plugin-version:${pluginVersion} -->`,
    `**Prove plugin v${pluginVersion}** — if the installed plugin version ` +
      `(\`cat ${pluginDir}/.claude-plugin/plugin.json | grep version\`) does not ` +
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
    lines.push(`- **${v.phase}**: \`${v.command}\``);
  }

  lines.push('');
  return lines.join('\n');
}

function renderDiscovery(pluginDir: string): string {
  const lines = [
    '## Discovery Protocol',
    '',
    'Before broad Glob/Grep searches, check the file index first:',
    '',
    `- \`bun run ${pluginDir}/packages/cli/bin/run.ts cafi context\` — full index with routing hints`,
    `- \`bun run ${pluginDir}/packages/cli/bin/run.ts cafi lookup <keyword>\` — search by keyword`,
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

function renderReferences(references: ReferenceEntry[], pluginDir: string): string {
  const lines: string[] = ['## References', ''];
  for (const ref of references) {
    const label = ref.label;
    const path = ref.path;
    const resolved = path ? path.replaceAll('$PLUGIN_DIR', pluginDir) : '';
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
