/**
 * Unit tests for the per-(team, role) agent file renderer + marker-merge writer.
 *
 * The writer is the marker-merge analog of the contributor identity artifact:
 * the engine owns a marked region + generated frontmatter, the operator owns the
 * body. These tests pin the contract the rest of the team-agent pipeline relies
 * on: both markers always present, a regeneration preserves an authored body
 * verbatim, a re-render is byte-stable, and the three roles all render.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TEAM_ROLES, type Team, type TeamRole } from '../types';
import {
  mergeTeamAgentArtifact,
  renderTeamAgentArtifact,
  teamAgentArtifactPath,
  teamAgentName,
  writeTeamAgentArtifact,
} from './team-agent-artifact';

const BEGIN_MARKER = '<!-- BEGIN GENERATED: team-context-protocol -->';
const END_MARKER = '<!-- END GENERATED: team-context-protocol -->';

function fakeTeam(overrides: Partial<Team> = {}): Team {
  return {
    slug: 'payments',
    team_type: 'stream_aligned',
    charter: null,
    lifetime: 'persistent',
    terminates_on_milestone: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('renderTeamAgentArtifact', () => {
  test('a fresh render carries both region markers', () => {
    const content = renderTeamAgentArtifact(fakeTeam(), 'tech_lead');
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain(END_MARKER);
  });

  test('the generated frontmatter names the seat and grants tools', () => {
    const content = renderTeamAgentArtifact(fakeTeam(), 'engineer');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('name: team-payments-engineer');
    expect(content).toContain('tools:');
  });

  test('all three roles render with the role in the seat name', () => {
    for (const role of TEAM_ROLES) {
      const content = renderTeamAgentArtifact(fakeTeam(), role);
      expect(content).toContain(`name: ${teamAgentName('payments', role)}`);
      expect(content).toContain(BEGIN_MARKER);
      expect(content).toContain(END_MARKER);
    }
  });

  test('TEAM_ROLES is the closed driving set', () => {
    expect(TEAM_ROLES).toEqual(['tech_lead', 'engineer', 'implementer']);
  });

  test('only tech_lead carries the Lore-record commitment', () => {
    const lead = renderTeamAgentArtifact(fakeTeam(), 'tech_lead');
    expect(lead).toContain('lore record');
    expect(lead).not.toContain('the tech_lead seat alone');

    for (const role of ['engineer', 'implementer'] as TeamRole[]) {
      const content = renderTeamAgentArtifact(fakeTeam(), role);
      expect(content).toContain('the tech_lead seat alone');
    }
  });

  test('a free-text charter does not break frontmatter, but description is engine-fixed', () => {
    const content = renderTeamAgentArtifact(
      fakeTeam({ charter: 'ship: fast, break: nothing' }),
      'tech_lead',
    );
    // Description is generated from slug/type/role, so a colon-bearing charter
    // never leaks into a frontmatter scalar unquoted.
    expect(content).toContain('description:');
    expect(content).toContain('PROVE_AGENT=team-payments-tech_lead');
  });
});

describe('mergeTeamAgentArtifact', () => {
  test('a regeneration preserves an authored body verbatim', () => {
    const fresh = renderTeamAgentArtifact(fakeTeam(), 'tech_lead');
    const authored = `${fresh}\n## AUTHORED_SENTINEL\nkeep me verbatim — colons: ok, markers? still fine\n`;
    const merged = mergeTeamAgentArtifact(authored, fakeTeam(), 'tech_lead');
    expect(merged).toContain('## AUTHORED_SENTINEL');
    expect(merged).toContain('keep me verbatim — colons: ok, markers? still fine');
  });

  test('a regeneration rewrites the marked region in place', () => {
    const fresh = renderTeamAgentArtifact(fakeTeam(), 'engineer');
    // Mutate the generated region; merge must overwrite it back to canonical.
    const tampered = fresh.replace('Self-serve at startup', 'Self-serve at startup — TAMPERED');
    expect(tampered).toContain('TAMPERED');
    const merged = mergeTeamAgentArtifact(tampered, fakeTeam(), 'engineer');
    expect(merged).not.toContain('TAMPERED');
    expect(merged).toContain(BEGIN_MARKER);
    expect(merged).toContain(END_MARKER);
  });

  test('a marker-less hand-authored file gets a prepended region, body preserved', () => {
    const handAuthored = '# my notes\nno markers here yet\n';
    const merged = mergeTeamAgentArtifact(handAuthored, fakeTeam(), 'implementer');
    expect(merged).toContain(BEGIN_MARKER);
    expect(merged).toContain(END_MARKER);
    expect(merged).toContain('# my notes');
    expect(merged).toContain('no markers here yet');
  });

  test('merging a freshly-rendered file is byte-stable (idempotent)', () => {
    const fresh = renderTeamAgentArtifact(fakeTeam(), 'tech_lead');
    const merged = mergeTeamAgentArtifact(fresh, fakeTeam(), 'tech_lead');
    expect(merged).toBe(fresh);
  });
});

describe('writeTeamAgentArtifact', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'team-agent-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes the file at .claude/agents/team-<slug>-<role>.md', () => {
    const path = writeTeamAgentArtifact(dir, fakeTeam(), 'tech_lead');
    expect(path).toBe(teamAgentArtifactPath(dir, 'payments', 'tech_lead'));
    const content = readFileSync(path, 'utf8');
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain(END_MARKER);
  });

  test('a second write preserves an authored body appended after the first', () => {
    const path = writeTeamAgentArtifact(dir, fakeTeam(), 'engineer');
    const authored = `${readFileSync(path, 'utf8')}\n## AUTHORED_SENTINEL\nkeep me\n`;
    writeFileSync(path, authored, 'utf8');

    writeTeamAgentArtifact(dir, fakeTeam(), 'engineer');
    const after = readFileSync(path, 'utf8');
    expect(after).toContain('AUTHORED_SENTINEL');
    expect(after).toContain('keep me');
  });

  test('a re-write with no intervening edit is byte-stable', () => {
    const path = writeTeamAgentArtifact(dir, fakeTeam(), 'implementer');
    const first = readFileSync(path, 'utf8');
    writeTeamAgentArtifact(dir, fakeTeam(), 'implementer');
    expect(readFileSync(path, 'utf8')).toBe(first);
  });

  test('all three roles write distinct files', () => {
    const team = fakeTeam();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    for (const role of TEAM_ROLES) {
      const path = writeTeamAgentArtifact(dir, team, role);
      expect(path.endsWith(`team-payments-${role}.md`)).toBe(true);
    }
  });
});
