/**
 * Tests for the two team-agent doctor checks: generated-region marker integrity
 * and registry-vs-filesystem drift.
 *
 * Each test seats teams through `runTeamCmd create` — the same writer the real
 * lifecycle uses — into a fresh `.git`-shaped tmpdir, so the on-disk
 * `.claude/agents/team-<slug>-<role>.md` files and the `.prove/prove.db`
 * registry are produced exactly as production does. The checks are then driven
 * through `runDoctor({ cwd })` and located in its results by name, so the test
 * exercises the public surface (discovery + wiring), not a private helper.
 *
 * The contract pinned here: a clean trio passes both checks; a corrupted marker
 * fails `team-agent-markers`; an orphaned file (unknown/inactive team) and an
 * active team missing a role file each fail `team-agent-drift`; every failing
 * result names `scrum team sync-agents`; and an absent agents dir or absent
 * store skips cleanly rather than hard-failing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTeamCmd } from '../scrum/cli/team-cmd';
import { TEAM_ROLES, type TeamRole } from '../scrum/types';
import { type CheckResult, runDoctor } from './doctor';

let workspace: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), 'doctor-team-agent-'));
  mkdirSync(join(workspace, '.git'), { recursive: true });
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Silence the team-cmd handler's stdout/stderr for the duration of `fn`. */
async function muted<T>(fn: () => Promise<T>): Promise<T> {
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

/** Seat a team via the CLI (writes the store row + the three role files). */
async function createTeam(slug: string): Promise<void> {
  const exit = await muted(() =>
    runTeamCmd('create', [undefined], {
      slug,
      teamType: 'stream_aligned',
      workspaceRoot: workspace,
    }),
  );
  expect(exit).toBe(0);
}

/** Disband a team via the CLI (flips it inactive, deletes its role files). */
async function terminateTeam(slug: string): Promise<void> {
  const exit = await muted(() => runTeamCmd('terminate', [slug], { workspaceRoot: workspace }));
  expect(exit).toBe(0);
}

/** The `.claude/agents/team-<slug>-<role>.md` path under the test workspace. */
function agentPath(slug: string, role: TeamRole): string {
  return join(workspace, '.claude', 'agents', `team-${slug}-${role}.md`);
}

/** Run doctor against the workspace and return the named check (or undefined). */
async function checkNamed(name: string): Promise<CheckResult | undefined> {
  return (await runDoctor({ cwd: workspace })).find((r) => r.name === name);
}

describe('checkTeamAgentMarkers', () => {
  test('clean trio passes and names the regen command', async () => {
    await createTeam('alpha');
    const result = await checkNamed('team-agent-markers');
    expect(result?.status).toBe('pass');
    // The regen command is surfaced even on pass so a single doctor run links
    // the check to its repair path.
    expect(result?.message).toContain('sync-agents');
  });

  test('a corrupted generated region fails with the sync-agents fix hint', async () => {
    await createTeam('beta');
    // Drop the END marker line, leaving an unterminated region.
    const path = agentPath('beta', 'engineer');
    const corrupted = readFileSync(path, 'utf8').replace(
      '<!-- END GENERATED: team-context-protocol -->',
      '',
    );
    writeFileSync(path, corrupted, 'utf8');

    const result = await checkNamed('team-agent-markers');
    expect(result?.status).toBe('fail');
    expect(result?.message).toContain('team-beta-engineer.md');
    expect(result?.fix).toContain('scrum team sync-agents');
  });

  test('a duplicated BEGIN marker (nested region) fails', async () => {
    await createTeam('gamma');
    const path = agentPath('gamma', 'tech_lead');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, `<!-- BEGIN GENERATED: team-context-protocol -->\n${original}`, 'utf8');

    const result = await checkNamed('team-agent-markers');
    expect(result?.status).toBe('fail');
    expect(result?.message).toContain('duplicate BEGIN');
  });

  test('absent agents dir skips cleanly', async () => {
    // No team seated → no .claude/agents — the check must not appear at all.
    const result = await checkNamed('team-agent-markers');
    expect(result).toBeUndefined();
  });
});

describe('checkTeamAgentRegistryDrift', () => {
  test('active team with its full trio reconciles (pass)', async () => {
    await createTeam('delta');
    const result = await checkNamed('team-agent-drift');
    expect(result?.status).toBe('pass');
  });

  test('an active team missing a role file fails', async () => {
    await createTeam('epsilon');
    rmSync(agentPath('epsilon', 'implementer'), { force: true });

    const result = await checkNamed('team-agent-drift');
    expect(result?.status).toBe('fail');
    expect(result?.message).toContain('team-epsilon-implementer.md');
    expect(result?.fix).toContain('scrum team sync-agents');
  });

  test('a role file for an unknown team is an orphan (fail)', async () => {
    await createTeam('zeta');
    // A file for a slug the registry never knew.
    const orphan = agentPath('ghost', 'engineer');
    writeFileSync(orphan, '# stray\n', 'utf8');

    const result = await checkNamed('team-agent-drift');
    expect(result?.status).toBe('fail');
    expect(result?.message).toContain('team-ghost-engineer.md');
    expect(result?.fix).toContain('scrum team sync-agents');
  });

  test('a role file surviving an inactive team is an orphan (fail)', async () => {
    await createTeam('eta');
    await terminateTeam('eta');
    // terminate deletes the files; resurrect one to simulate a stale survivor.
    writeFileSync(agentPath('eta', 'tech_lead'), '# stale\n', 'utf8');

    const result = await checkNamed('team-agent-drift');
    expect(result?.status).toBe('fail');
    expect(result?.message).toContain('team-eta-tech_lead.md');
  });

  test('absent store skips cleanly when no agent files exist', async () => {
    // Fresh workspace: no store, no agents dir.
    const result = await checkNamed('team-agent-drift');
    expect(result).toBeUndefined();
  });

  test('agent files present with no store warn rather than hard-fail', async () => {
    const dir = join(workspace, '.claude', 'agents');
    mkdirSync(dir, { recursive: true });
    for (const role of TEAM_ROLES) {
      writeFileSync(join(dir, `team-orphaned-${role}.md`), '# file\n', 'utf8');
    }

    const result = await checkNamed('team-agent-drift');
    expect(result?.status).toBe('warn');
    expect(result?.fix).toContain('scrum team sync-agents');
  });
});
