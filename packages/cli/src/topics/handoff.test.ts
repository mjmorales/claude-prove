/**
 * Tests for the `handoff` topic (ported gather-context.sh).
 *
 * Builds real temp git repos and asserts on the markdown `gatherContext`
 * returns. The headline case is the regression the bash port fixes: a repo
 * with no `main`/`master` branch must not crash (the script hit an unbound
 * `MERGE_BASE` under `set -u`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherContext } from './handoff/gather';

let base: string;
let repo: string;

function git(args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function write(rel: string, content: string): void {
  const full = join(repo, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'handoff-'));
  repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('gatherContext', () => {
  test('no main/master branch does not crash (the bash MERGE_BASE bug)', () => {
    execFileSync('git', ['init', '-qb', 'feature/x', repo]);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    write('a.txt', 'a\n');
    git(['add', 'a.txt']);
    git(['commit', '-qm', 'feat: a']);

    const md = gatherContext({ projectRoot: repo });
    expect(md).toContain('## State');
    expect(md).toContain('- **Branch**: `feature/x`');
    expect(md).toContain('feat: a'); // recent commits fallback (-5)
    expect(md).not.toContain('Changes from'); // no main → no diff stat
  });

  test('with main branch + staged/unstaged shows diff stat and modified files', () => {
    execFileSync('git', ['init', '-qb', 'main', repo]);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    write('base.txt', 'base\n');
    git(['add', 'base.txt']);
    git(['commit', '-qm', 'init']);
    git(['checkout', '-qb', 'feature/y']);
    write('feat.txt', 'feat\n');
    git(['add', 'feat.txt']);
    git(['commit', '-qm', 'feat: y']);
    // a staged + an unstaged tracked modification
    write('staged.txt', 's\n');
    git(['add', 'staged.txt']);
    write('base.txt', 'changed\n'); // unstaged modification of a tracked file

    const md = gatherContext({ projectRoot: repo });
    expect(md).toContain('**Changes from main**');
    expect(md).toContain('**Staged:**');
    expect(md).toContain('`staged.txt`');
    expect(md).toContain('**Unstaged:**');
    expect(md).toContain('`base.txt`');
  });

  test('enumerates prove artifacts and renders task-plan-step headings', () => {
    execFileSync('git', ['init', '-qb', 'main', repo]);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    write('f.txt', 'x\n');
    git(['add', 'f.txt']);
    git(['commit', '-qm', 'init']);

    write('.prove/decisions/d.md', '# decision\n');
    write(
      '.prove/runs/feature/add-login/state.json',
      JSON.stringify({
        schema_version: '1',
        kind: 'state',
        run_status: 'running',
        slug: 'add-login',
        branch: 'feature',
        current_task: '',
        current_step: '',
        started_at: '',
        updated_at: '2026-05-30T00:00:00.000Z',
        ended_at: '',
        tasks: [],
        dispatch: { dispatched: [] },
      }),
    );

    const md = gatherContext({ projectRoot: repo });
    expect(md).toContain('- `.prove/runs/feature/add-login/` — orchestrator run state');
    expect(md).toContain('- `.prove/decisions/` — decision records');
    expect(md).toContain('## Task Plan Steps (feature/add-login)');
  });

  test('empty .prove yields the git-only note', () => {
    execFileSync('git', ['init', '-qb', 'main', repo]);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    write('f.txt', 'x\n');
    git(['add', 'f.txt']);
    git(['commit', '-qm', 'init']);

    const md = gatherContext({ projectRoot: repo });
    expect(md).toContain('No prove artifacts found. Context is git-only.');
  });
});
