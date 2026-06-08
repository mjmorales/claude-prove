/**
 * Lifecycle tests for the team-agent-file sync wired into `scrum team`.
 *
 * `runTeamCmd` opens its own `ScrumStore` against the unified prove.db, so each
 * test chdir's into a fresh `.git`-shaped tmpdir (so `mainWorktreeRoot()`
 * resolves) and passes that root as `workspaceRoot`. stdout/stderr are captured
 * by patching `process.stdout.write` / `process.stderr.write` for the call.
 *
 * The contract pinned here: `create` writes the three per-role agent files with
 * both region markers, `rotate` regenerates them without clobbering an authored
 * body edit, `terminate` deletes all three, and an agent-file write failure stays
 * non-fatal — it never changes the command exit code.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TEAM_ROLES, type TeamRole } from '../types';
import { runTeamCmd } from './team-cmd';

const BEGIN_MARKER = '<!-- BEGIN GENERATED: team-context-protocol -->';
const END_MARKER = '<!-- END GENERATED: team-context-protocol -->';

interface Captured {
  stdout: string;
  stderr: string;
  exit: number;
}

async function withCapture(fn: () => number | Promise<number>): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await fn();
    return { stdout, stderr, exit };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

let workspace: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), 'team-cmd-unit-'));
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

/** The `.claude/agents/team-<slug>-<role>.md` path under the test workspace. */
function agentPath(slug: string, role: TeamRole): string {
  return join(workspace, '.claude', 'agents', `team-${slug}-${role}.md`);
}

/** Seat a team via the CLI, asserting exit 0. */
async function createTeam(slug: string): Promise<void> {
  const res = await withCapture(() =>
    runTeamCmd('create', [undefined], {
      slug,
      teamType: 'stream_aligned',
      workspaceRoot: workspace,
    }),
  );
  expect(res.exit).toBe(0);
}

describe('runTeamCmd create — agent files', () => {
  test('writes all three role files with both region markers', async () => {
    await createTeam('alpha');
    for (const role of TEAM_ROLES) {
      const path = agentPath('alpha', role);
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, 'utf8');
      expect(content).toContain(BEGIN_MARKER);
      expect(content).toContain(END_MARKER);
      expect(content).toContain(`name: team-alpha-${role}`);
    }
  });

  test('an agent-file write failure does not change the exit code', async () => {
    // Make `.claude/agents` a non-writable directory so the per-role writes
    // throw, proving the failure is reported but non-fatal.
    const agentsDir = join(workspace, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    chmodSync(agentsDir, 0o500);
    try {
      const res = await withCapture(() =>
        runTeamCmd('create', [undefined], {
          slug: 'beta',
          teamType: 'stream_aligned',
          workspaceRoot: workspace,
        }),
      );
      expect(res.exit).toBe(0);
      expect(res.stderr).toContain('write failed');
    } finally {
      chmodSync(agentsDir, 0o700);
    }
  });
});

describe('runTeamCmd rotate — agent files', () => {
  test('regenerates the role files preserving an authored body', async () => {
    await createTeam('gamma');
    const leadPath = agentPath('gamma', 'tech_lead');
    const authored = `${readFileSync(leadPath, 'utf8')}\n## AUTHORED_SENTINEL\nkeep me\n`;
    writeFileSync(leadPath, authored, 'utf8');

    const res = await withCapture(() =>
      runTeamCmd('rotate', ['gamma'], {
        role: 'tech_lead',
        contributor: 'CT-00000000-0000-0000-0000-000000000001',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);

    const after = readFileSync(leadPath, 'utf8');
    expect(after).toContain('AUTHORED_SENTINEL');
    expect(after).toContain('keep me');
    expect(after).toContain(BEGIN_MARKER);
    expect(after).toContain(END_MARKER);
  });
});

describe('runTeamCmd terminate — agent files', () => {
  test('deletes all three role files', async () => {
    await createTeam('delta');
    for (const role of TEAM_ROLES) {
      expect(existsSync(agentPath('delta', role))).toBe(true);
    }

    const res = await withCapture(() => runTeamCmd('terminate', ['delta'], { workspaceRoot: workspace }));
    expect(res.exit).toBe(0);

    for (const role of TEAM_ROLES) {
      expect(existsSync(agentPath('delta', role))).toBe(false);
    }
  });

  test('tolerates already-absent agent files (no throw, exit 0)', async () => {
    await createTeam('epsilon');
    // Remove the agent files out-of-band, then terminate — the rm tolerates ENOENT.
    for (const role of TEAM_ROLES) {
      rmSync(agentPath('epsilon', role), { force: true });
    }
    const res = await withCapture(() =>
      runTeamCmd('terminate', ['epsilon'], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);
  });
});

describe('runTeamCmd sync-agents', () => {
  test('regenerates every active team and reports the synced slugs', async () => {
    await createTeam('one');
    await createTeam('two');
    // Drop one file so sync-agents has something to rewrite.
    rmSync(agentPath('one', 'engineer'), { force: true });

    const res = await withCapture(() =>
      runTeamCmd('sync-agents', [undefined], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(['one', 'two']);
    expect(existsSync(agentPath('one', 'engineer'))).toBe(true);
  });

  test('a named slug syncs only that team', async () => {
    await createTeam('solo');
    const res = await withCapture(() =>
      runTeamCmd('sync-agents', ['solo'], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(['solo']);
  });

  test('an unknown slug exits 1', async () => {
    const res = await withCapture(() =>
      runTeamCmd('sync-agents', ['ghost'], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stdout.trim()).toBe('null');
  });

  test('a terminated team is skipped by the all-teams sync', async () => {
    await createTeam('live');
    await createTeam('dead');
    await withCapture(() => runTeamCmd('terminate', ['dead'], { workspaceRoot: workspace }));

    const res = await withCapture(() =>
      runTeamCmd('sync-agents', [undefined], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(['live']);
  });

  test('preserves an authored body across a backfill', async () => {
    await createTeam('keep');
    const leadPath = agentPath('keep', 'tech_lead');
    const authored = `${readFileSync(leadPath, 'utf8')}\n## AUTHORED_SENTINEL\nkeep me\n`;
    writeFileSync(leadPath, authored, 'utf8');

    const res = await withCapture(() =>
      runTeamCmd('sync-agents', ['keep'], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);

    const after = readFileSync(leadPath, 'utf8');
    expect(after).toContain('AUTHORED_SENTINEL');
    expect(after).toContain('keep me');
    expect(after).toContain(BEGIN_MARKER);
    expect(after).toContain(END_MARKER);
  });

  test('is byte-stable on a second run', async () => {
    await createTeam('stable');
    await withCapture(() => runTeamCmd('sync-agents', [undefined], { workspaceRoot: workspace }));
    const firstPass = TEAM_ROLES.map((role) => readFileSync(agentPath('stable', role), 'utf8'));

    const res = await withCapture(() =>
      runTeamCmd('sync-agents', [undefined], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);

    TEAM_ROLES.forEach((role, i) => {
      expect(readFileSync(agentPath('stable', role), 'utf8')).toBe(firstPass[i]);
    });
  });
});
