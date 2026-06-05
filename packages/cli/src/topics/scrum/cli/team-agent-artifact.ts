/**
 * Per-(team, role) agent file rendering + marker-merge writing for
 * `.claude/agents/team-<slug>-<role>.md`.
 *
 * Each active team gets one agent file per `TeamRole` (tech_lead | engineer |
 * implementer). The file is a hybrid artifact:
 *
 *   - GENERATED frontmatter (`name` / `description` / `tools`) plus a
 *     `Team Context Protocol` block wrapped in explicit region markers. The
 *     engine owns this region and rewrites it on every reconciliation.
 *   - An AUTHORED body the operator may edit freely outside the markers. The
 *     marker-merge writer preserves it byte-for-byte across regenerations.
 *
 * This is the marker-merge analog of the contributor identity artifact, where a
 * frontmatter block is dropped and re-spliced while the body is preserved. Here
 * the preserved/regenerated boundary is an in-body region delimited by markers
 * (plus generated frontmatter), NOT a YAML block — so the file can carry
 * regenerated machine state and human prose side by side without either
 * clobbering the other.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Team, TeamRole } from '../types';

/** Region marker opening the engine-owned Team Context Protocol block. */
const BEGIN_MARKER = '<!-- BEGIN GENERATED: team-context-protocol -->';

/** Region marker closing the engine-owned Team Context Protocol block. */
const END_MARKER = '<!-- END GENERATED: team-context-protocol -->';

/**
 * Matches the marked region inclusive of both markers — the span the writer
 * replaces on regeneration. Non-greedy across the body so an authored section
 * that happens to mention a marker name does not extend the match. Anchored on
 * the exact comment markers, which a human body is not expected to reproduce.
 */
const REGION_RE = new RegExp(`${escapeRegExp(BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}`);

/** Escape a literal string for embedding in a RegExp source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The agent's tool grant. A team agent reads its own bundle, resolves its seat,
 * inspects cross-team contracts, edits in-scope source, and records memory
 * through the CLI — Read/Edit/Write/Bash cover all four, and AskUserQuestion
 * lets it gate a judgment call back to the operator.
 */
const AGENT_TOOLS = 'Read, Edit, Write, Bash, AskUserQuestion';

/**
 * The on-disk agent file path for a (team, role): `.claude/agents/`-rooted so
 * Claude Code discovers it as a project agent.
 */
export function teamAgentArtifactPath(workspaceRoot: string, slug: string, role: TeamRole): string {
  return join(workspaceRoot, '.claude', 'agents', `team-${slug}-${role}.md`);
}

/**
 * The canonical agent name for a (team, role): `team-<slug>-<role>`. This is
 * both the frontmatter `name` and the `PROVE_AGENT` value the agent's writes
 * stamp, so a write is always attributable to a single seat.
 */
export function teamAgentName(slug: string, role: TeamRole): string {
  return `team-${slug}-${role}`;
}

/**
 * Render a (team, role) agent file from scratch: generated frontmatter, the
 * marked Team Context Protocol region, and an authored-body placeholder. The
 * placeholder sits OUTSIDE the markers so a later regeneration preserves any
 * operator edits made in its place.
 */
export function renderTeamAgentArtifact(team: Team, role: TeamRole): string {
  return `${renderFrontmatter(team, role)}\n\n${renderRegion(team, role)}\n\n${renderBodyPlaceholder(team, role)}\n`;
}

/**
 * Write the (team, role) agent file. When ABSENT, write the full skeleton
 * (generated region + authored-body placeholder). When PRESENT, splice ONLY the
 * marked region — regenerate the frontmatter and protocol block while preserving
 * everything outside the markers byte-for-byte. Returns the written path.
 */
export function writeTeamAgentArtifact(workspaceRoot: string, team: Team, role: TeamRole): string {
  const path = teamAgentArtifactPath(workspaceRoot, team.slug, role);
  const content = existsSync(path)
    ? mergeTeamAgentArtifact(readFileSync(path, 'utf8'), team, role)
    : renderTeamAgentArtifact(team, role);
  mkdirSync(join(workspaceRoot, '.claude', 'agents'), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

/**
 * Merge a freshly-generated region + frontmatter into an EXISTING artifact,
 * preserving its authored body byte-for-byte. Two shapes arrive here:
 *
 *   - Marked (the standard skeleton, or a prior write): the frontmatter is
 *     replaced and the marked region is re-spliced in place; every byte outside
 *     the markers — including an authored body the operator added — passes
 *     through unchanged.
 *   - Marker-less (a hand-authored file with no region yet): a fresh region is
 *     prepended above the existing content, which becomes the body unchanged.
 */
export function mergeTeamAgentArtifact(existing: string, team: Team, role: TeamRole): string {
  const region = renderRegion(team, role);
  const withRegion = REGION_RE.test(existing)
    ? existing.replace(REGION_RE, region)
    : `${region}\n\n${existing}`;
  return replaceFrontmatter(withRegion, renderFrontmatter(team, role));
}

/** Matches a leading YAML frontmatter block: opening fence, inner lines, closing fence. */
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---(\n|$)/;

/**
 * Replace the leading frontmatter block with a freshly-generated one, leaving
 * the rest of the document untouched. When no frontmatter is present (a body
 * that lost its header), the fresh frontmatter is prepended.
 */
function replaceFrontmatter(content: string, frontmatter: string): string {
  if (FRONTMATTER_RE.test(content)) {
    return content.replace(FRONTMATTER_RE, `${frontmatter}\n`);
  }
  return `${frontmatter}\n\n${content}`;
}

/** Generated agent frontmatter: `name` / `description` / `tools`. */
function renderFrontmatter(team: Team, role: TeamRole): string {
  return [
    '---',
    `name: ${teamAgentName(team.slug, role)}`,
    `description: ${yamlValue(roleDescription(team, role))}`,
    `tools: ${AGENT_TOOLS}`,
    '---',
  ].join('\n');
}

/** One-line role-scoped description for the agent's frontmatter. */
function roleDescription(team: Team, role: TeamRole): string {
  return `${role} seat on team ${team.slug} (${team.team_type}). Operates strictly within the team's scope and writes only through the prove CLI under PROVE_AGENT=${teamAgentName(team.slug, role)}.`;
}

/**
 * The engine-owned Team Context Protocol region, wrapped in the region markers.
 * The judgment framing is authored prose held in `PROTOCOL_PROSE`; the engine
 * assembles only the markers, the role line, and the per-role write commitments.
 */
function renderRegion(team: Team, role: TeamRole): string {
  return [
    BEGIN_MARKER,
    '',
    `# Team Context Protocol — ${teamAgentName(team.slug, role)}`,
    '',
    PROTOCOL_PROSE(team, role),
    '',
    END_MARKER,
  ].join('\n');
}

/**
 * The authored protocol prose — the judgment framing every team agent operates
 * under. Self-serve at startup, the read boundary, the write commitments, and
 * the attribution rule, role-specialized via the closed `TeamRole` set.
 */
function PROTOCOL_PROSE(team: Team, role: TeamRole): string {
  const name = teamAgentName(team.slug, role);
  return [
    '## Self-serve at startup',
    '',
    `- Read your own bundle first: \`teams/${team.slug}.md\`. It carries your scope, roster, interface, and recent Lore.`,
    `- Resolve your seated contributor (CT-UUID) with \`claude-prove scrum team roster ${team.slug}\`.`,
    "- Never read another team's bundle. Cross-team contracts are visible only through the manifest.",
    `- For a cross-team contract, read \`claude-prove scrum manifest show\` — never reach into a sibling team's \`teams/<slug>.md\`.`,
    '',
    '## Write commitments',
    '',
    ...writeCommitments(role),
    `- Every write stamps \`PROVE_AGENT=${name}\` and your resolved CT-UUID, so a write is attributable to this seat.`,
    '- Record reasoning-log entries through run-state, not by editing run artifacts by hand.',
    `- Raw edits to \`teams/${team.slug}.md\` are forbidden — the bundle is engine-reconciled. Change team state through \`claude-prove scrum team ...\` so the artifact and the store stay in sync.`,
  ].join('\n');
}

/**
 * Per-role write commitments. `annotation add` is open to every role;
 * `lore record` is the tech_lead's alone — the role that owns team memory.
 */
function writeCommitments(role: TeamRole): string[] {
  const lines = [
    '- Record annotations with `claude-prove scrum annotation add` (open to every role).',
  ];
  if (role === 'tech_lead') {
    lines.push('- Record team Lore with `claude-prove scrum lore record` (tech_lead only).');
  } else {
    lines.push(
      '- Do NOT record Lore — `claude-prove scrum lore record` is the tech_lead seat alone.',
    );
  }
  return lines;
}

/** Authored-body placeholder, written below the marked region on a fresh skeleton. */
function renderBodyPlaceholder(team: Team, role: TeamRole): string {
  return [
    `## ${teamAgentName(team.slug, role)} — operator notes`,
    '',
    '<!-- Authored guidance for this seat. Edits here survive regeneration. -->',
  ].join('\n');
}

/**
 * Render a string as a safe YAML scalar. Plain identifiers are emitted verbatim;
 * anything with colons, leading special characters, or a YAML keyword collision
 * is JSON-quoted — valid YAML-1.2 scalar syntax with correct escape handling.
 */
function yamlValue(value: string): string {
  if (
    /^[A-Za-z0-9][\w .@+-]*$/.test(value) &&
    !/^(true|false|null|yes|no|on|off|~)$/i.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}
