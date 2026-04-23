/**
 * Tests for acb.hook — Claude Code PostToolUse hook logic.
 *
 * Ported from `tools/acb/test_hook.py` (394 lines). Coverage matrix:
 *   - Tool filter (non-Bash, non-commit)
 *   - commitSucceeded shapes (is_error / isError / exit_code / exitCode)
 *   - parseEffectiveCwd matrix (quoted, unquoted, env-var skip, subshell,
 *     separator variants, last-cd wins, after-commit ignored, nonexistent
 *     path falls back, absolute vs relative)
 *   - main/master branch skip
 *   - orchestrator/* and task/* branches without slug emit guard block
 *   - Manifest present -> silent pass
 *   - Manifest missing -> block with MANIFEST_PROMPT
 *   - 4 golden-fixture byte-parity assertions against Python captures
 *
 * Total assertions: >=25.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearRegistry } from '@claude-prove/store';
import {
  type ClaudeCodeHookPayload,
  commitSucceeded,
  generateManifestPrompt,
  parseEffectiveCwd,
  runHookPostCommit,
} from './hook';
import { ensureAcbSchemaRegistered, openAcbStore } from './store';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURES_DIR = join(__dirname, '__fixtures__', 'hook-prompts', 'python-captures');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `acb-hook-${prefix}-`));
}

/**
 * Initialize a git repo with one commit on `branchName`. Returns root.
 * Uses `-c init.defaultBranch=<branch>` so the initial branch is created
 * correctly without needing separate `git branch -m`.
 */
function initRepo(dir: string, branchName: string): string {
  run(['git', '-c', `init.defaultBranch=${branchName}`, 'init', '--quiet'], dir);
  run(['git', 'config', 'user.email', 'test@example.com'], dir);
  run(['git', 'config', 'user.name', 'test'], dir);
  run(['git', 'config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  run(['git', 'add', '.'], dir);
  run(['git', 'commit', '--quiet', '-m', 'init'], dir);
  return dir;
}

function run(cmd: string[], cwd: string): void {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    const err = proc.stderr?.toString() ?? '';
    throw new Error(`${cmd.join(' ')} failed (exit ${proc.exitCode}): ${err}`);
  }
}

function runStdout(cmd: string[], cwd: string): string {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed: ${proc.stderr?.toString() ?? ''}`);
  }
  return proc.stdout?.toString().trim() ?? '';
}

/** Minimal valid manifest payload for seeding the store. */
function makeManifest(sha: string): Record<string, unknown> {
  return {
    acb_manifest_version: '0.2',
    commit_sha: sha,
    timestamp: '2026-04-22T12:00:00Z',
    intent_groups: [
      {
        id: 'g1',
        title: 'Test',
        classification: 'explicit',
        file_refs: [{ path: 'README.md' }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. Tool + command filter
// ---------------------------------------------------------------------------

describe('runHookPostCommit — filter layer', () => {
  test('non-Bash tool returns silent', () => {
    const result = runHookPostCommit({
      workspaceRoot: '/tmp/nope',
      payload: { tool_name: 'Read', tool_input: {} },
    });
    expect(result.stdout).toBe('');
    expect(result.exit).toBe(0);
  });

  test('Bash but non-commit command returns silent', () => {
    const result = runHookPostCommit({
      workspaceRoot: '/tmp/nope',
      payload: { tool_name: 'Bash', tool_input: { command: 'git push origin main' } },
    });
    expect(result.stdout).toBe('');
  });

  test('Bash with git log is not git commit', () => {
    const result = runHookPostCommit({
      workspaceRoot: '/tmp/nope',
      payload: { tool_name: 'Bash', tool_input: { command: 'git log --oneline' } },
    });
    expect(result.stdout).toBe('');
  });

  test('git commit --amend matches', () => {
    // Failure path keeps it silent because tool_response says exit_code=1.
    const result = runHookPostCommit({
      workspaceRoot: '/tmp/nope',
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'git commit --amend' },
        tool_response: { exit_code: 1 },
      },
    });
    expect(result.stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 2. commitSucceeded
// ---------------------------------------------------------------------------

describe('commitSucceeded', () => {
  test('null response -> true', () => {
    expect(commitSucceeded(null)).toBe(true);
  });

  test('non-object response -> true', () => {
    expect(commitSucceeded('ok')).toBe(true);
    expect(commitSucceeded(42)).toBe(true);
  });

  test('is_error: true -> false', () => {
    expect(commitSucceeded({ is_error: true })).toBe(false);
  });

  test('isError: true -> false', () => {
    expect(commitSucceeded({ isError: true })).toBe(false);
  });

  test('exit_code non-zero -> false', () => {
    expect(commitSucceeded({ exit_code: 1 })).toBe(false);
  });

  test('exitCode non-zero -> false', () => {
    expect(commitSucceeded({ exitCode: 128 })).toBe(false);
  });

  test('exit_code zero -> true', () => {
    expect(commitSucceeded({ exit_code: 0 })).toBe(true);
  });

  test('no fields -> true', () => {
    expect(commitSucceeded({})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. parseEffectiveCwd matrix
// ---------------------------------------------------------------------------

describe('parseEffectiveCwd', () => {
  const ctx = { root: '' };

  beforeAll(() => {
    ctx.root = makeTmp('cwd');
    mkdirSync(join(ctx.root, 'wt'));
    mkdirSync(join(ctx.root, 'main'));
    mkdirSync(join(ctx.root, 'wt with space'));
  });

  afterAll(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  test('no cd -> fallback', () => {
    expect(parseEffectiveCwd("git commit -m 'msg'", ctx.root)).toBe(ctx.root);
  });

  test('cd absolute path resolves', () => {
    const wt = join(ctx.root, 'wt');
    expect(parseEffectiveCwd(`cd ${wt} && git commit -m 'msg'`, ctx.root)).toBe(wt);
  });

  test('cd relative path resolves against fallback', () => {
    expect(parseEffectiveCwd("cd wt && git commit -m 'msg'", ctx.root)).toBe(join(ctx.root, 'wt'));
  });

  test('cd double-quoted path with space', () => {
    const wt = join(ctx.root, 'wt with space');
    expect(parseEffectiveCwd(`cd "${wt}" && git commit -m "msg"`, ctx.root)).toBe(wt);
  });

  test('cd single-quoted path', () => {
    const wt = join(ctx.root, 'wt');
    expect(parseEffectiveCwd(`cd '${wt}' && git commit -m msg`, ctx.root)).toBe(wt);
  });

  test('cd with env var falls back', () => {
    expect(parseEffectiveCwd('cd $WORKTREE && git commit -m msg', ctx.root)).toBe(ctx.root);
  });

  test('cd with tilde falls back', () => {
    expect(parseEffectiveCwd('cd ~ && git commit -m msg', ctx.root)).toBe(ctx.root);
  });

  test('cd with backtick falls back', () => {
    expect(parseEffectiveCwd('cd `pwd` && git commit -m msg', ctx.root)).toBe(ctx.root);
  });

  test('cd to nonexistent path falls back', () => {
    expect(parseEffectiveCwd(`cd ${ctx.root}/bogus && git commit`, ctx.root)).toBe(ctx.root);
  });

  test('last cd before commit wins', () => {
    const wt = join(ctx.root, 'wt');
    const main = join(ctx.root, 'main');
    expect(parseEffectiveCwd(`cd ${main} && cd ${wt} && git commit`, ctx.root)).toBe(wt);
  });

  test('cd after commit is ignored', () => {
    const wt = join(ctx.root, 'wt');
    expect(parseEffectiveCwd(`git commit -m msg && cd ${wt}`, ctx.root)).toBe(ctx.root);
  });

  test('subshell parens still match', () => {
    const wt = join(ctx.root, 'wt');
    expect(parseEffectiveCwd(`(cd ${wt} && git commit -m msg)`, ctx.root)).toBe(wt);
  });

  test('semicolon separator', () => {
    const wt = join(ctx.root, 'wt');
    expect(parseEffectiveCwd(`cd ${wt}; git commit -m msg`, ctx.root)).toBe(wt);
  });

  test('chained cd; cd uses last', () => {
    const wt = join(ctx.root, 'wt');
    const main = join(ctx.root, 'main');
    expect(parseEffectiveCwd(`cd ${main}; cd ${wt} && git commit`, ctx.root)).toBe(wt);
  });
});

// ---------------------------------------------------------------------------
// 4. Full hook with real git + store
// ---------------------------------------------------------------------------

describe('runHookPostCommit — integration with real repo', () => {
  const ctx = { root: '' };

  beforeAll(() => {
    clearRegistry();
    ensureAcbSchemaRegistered();
  });

  afterAll(() => {
    if (ctx.root) rmSync(ctx.root, { recursive: true, force: true });
  });

  test('main branch -> silent pass', () => {
    const root = makeTmp('main-skip');
    initRepo(root, 'main');
    mkdirSync(join(root, '.prove'));
    const result = runHookPostCommit({
      workspaceRoot: root,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m test' },
        tool_response: { exit_code: 0 },
        cwd: root,
      },
    });
    expect(result.stdout).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  test('master branch -> silent pass', () => {
    const root = makeTmp('master-skip');
    initRepo(root, 'master');
    const result = runHookPostCommit({
      workspaceRoot: root,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m test' },
        tool_response: { exit_code: 0 },
        cwd: root,
      },
    });
    expect(result.stdout).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  test('feature branch + manifest missing -> block with MANIFEST_PROMPT', () => {
    const root = makeTmp('miss');
    initRepo(root, 'feature/auth');
    mkdirSync(join(root, '.prove'));
    const sha = runStdout(['git', 'rev-parse', 'HEAD'], root);

    const result = runHookPostCommit({
      workspaceRoot: root,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m test' },
        tool_response: { exit_code: 0 },
        cwd: root,
      },
    });

    expect(result.stdout.length).toBeGreaterThan(0);
    const decision = JSON.parse(result.stdout) as { decision: string; reason: string };
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('feature/auth');
    expect(decision.reason).toContain(sha.slice(0, 12));
    expect(decision.reason).toContain(`--workspace-root ${root}`);
    expect(decision.reason).toContain('bun run');
    expect(decision.reason).toContain('acb save-manifest');
    expect(decision.reason).not.toContain('PYTHONPATH=');
    rmSync(root, { recursive: true, force: true });
  });

  test('feature branch + manifest present -> silent pass', () => {
    const root = makeTmp('hit');
    initRepo(root, 'feature/auth');
    mkdirSync(join(root, '.prove'));
    const sha = runStdout(['git', 'rev-parse', 'HEAD'], root);

    // Seed manifest via the store.
    const dbPath = join(root, '.prove', 'prove.db');
    const store = openAcbStore({ override: dbPath });
    store.saveManifest('feature/auth', sha, makeManifest(sha));
    store.close();

    const result = runHookPostCommit({
      workspaceRoot: root,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m test' },
        tool_response: { exit_code: 0 },
        cwd: root,
      },
    });
    expect(result.stdout).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  test('failed commit (exit_code=1) -> silent regardless of manifest state', () => {
    const root = makeTmp('fail');
    initRepo(root, 'feature/auth');
    mkdirSync(join(root, '.prove'));
    const result = runHookPostCommit({
      workspaceRoot: root,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m test' },
        tool_response: { exit_code: 1 },
        cwd: root,
      },
    });
    expect(result.stdout).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  test('orchestrator/* branch without slug -> block with guard text', () => {
    const root = makeTmp('orchestrator-guard');
    initRepo(root, 'orchestrator/demo');
    mkdirSync(join(root, '.prove'));
    const result = runHookPostCommit({
      workspaceRoot: root,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m test' },
        tool_response: { exit_code: 0 },
        cwd: root,
      },
    });
    expect(result.stdout.length).toBeGreaterThan(0);
    const decision = JSON.parse(result.stdout) as { decision: string; reason: string };
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('orchestrator/demo');
    expect(decision.reason).toContain('.prove-wt-slug.txt');
    expect(decision.reason).toContain('no run slug');
    rmSync(root, { recursive: true, force: true });
  });

  test('task/* branch without slug -> block with guard text', () => {
    const root = makeTmp('task-guard');
    initRepo(root, 'task/demo/1.1');
    mkdirSync(join(root, '.prove'));
    const result = runHookPostCommit({
      workspaceRoot: root,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m test' },
        tool_response: { exit_code: 0 },
        cwd: root,
      },
    });
    const decision = JSON.parse(result.stdout) as { decision: string; reason: string };
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('task/demo/1.1');
    expect(decision.reason).toContain('.prove-wt-slug.txt');
    rmSync(root, { recursive: true, force: true });
  });

  test('orchestrator/* with .prove-wt-slug.txt falls through to manifest check', () => {
    const root = makeTmp('orchestrator-ok');
    initRepo(root, 'orchestrator/demo');
    mkdirSync(join(root, '.prove'));
    writeFileSync(join(root, '.prove-wt-slug.txt'), 'demo\n', 'utf8');
    const result = runHookPostCommit({
      workspaceRoot: root,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m test' },
        tool_response: { exit_code: 0 },
        cwd: root,
      },
    });
    const decision = JSON.parse(result.stdout) as { decision: string; reason: string };
    expect(decision.decision).toBe('block');
    // Manifest-missing block, not the slug guard.
    expect(decision.reason).not.toContain('no run slug');
    expect(decision.reason).toContain('--slug demo');
    rmSync(root, { recursive: true, force: true });
  });

  test('manifest tagged with slug satisfies hasManifestForSha(sha, slug)', () => {
    const root = makeTmp('slug-hit');
    initRepo(root, 'orchestrator/demo');
    mkdirSync(join(root, '.prove'));
    writeFileSync(join(root, '.prove-wt-slug.txt'), 'demo\n', 'utf8');
    const sha = runStdout(['git', 'rev-parse', 'HEAD'], root);

    const dbPath = join(root, '.prove', 'prove.db');
    const store = openAcbStore({ override: dbPath });
    store.saveManifest('orchestrator/demo', sha, makeManifest(sha), 'demo');
    store.close();

    const result = runHookPostCommit({
      workspaceRoot: root,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m test' },
        tool_response: { exit_code: 0 },
        cwd: root,
      },
    });
    expect(result.stdout).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  test('cd X && git commit flows cwd to git helpers (session cwd ignored)', () => {
    const outer = makeTmp('cd-flow');
    // Main session cwd: a plain non-repo dir so if the hook used IT, git
    // helpers return null and the path would silent-pass. We want the
    // worktree cd target to win, producing a block.
    mkdirSync(join(outer, 'session'));
    const wt = join(outer, 'wt');
    mkdirSync(wt);
    initRepo(wt, 'feature/auth');

    mkdirSync(join(wt, '.prove'));
    const result = runHookPostCommit({
      workspaceRoot: wt,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: `cd ${wt} && git commit -m msg` },
        tool_response: { exit_code: 0 },
        cwd: join(outer, 'session'),
      },
    });
    // Since cwd flows through to the worktree, branch resolves to
    // feature/auth and the hook blocks on a missing manifest.
    expect(result.stdout.length).toBeGreaterThan(0);
    const decision = JSON.parse(result.stdout) as { decision: string; reason: string };
    expect(decision.reason).toContain('feature/auth');
    rmSync(outer, { recursive: true, force: true });
  });

  test('HEAD unresolvable (no git repo at cwd) -> silent', () => {
    const root = makeTmp('no-repo');
    // Not a git repo — currentBranch returns null.
    const result = runHookPostCommit({
      workspaceRoot: root,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m test' },
        tool_response: { exit_code: 0 },
        cwd: root,
      },
    });
    expect(result.stdout).toBe('');
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 5. MANIFEST_PROMPT golden-fixture byte-parity
// ---------------------------------------------------------------------------

describe('generateManifestPrompt — golden fixtures', () => {
  /** Rewrite Python's `PYTHONPATH=X python3 -m tools.acb save-manifest ...`
   * line to its `bun run X/packages/cli/bin/run.ts acb save-manifest ...`
   * TS equivalent so the rest of the prompt can be asserted byte-equal. */
  function rewriteInvocation(py: string): string {
    return py.replace(
      /^PYTHONPATH=(.+?) python3 -m tools\.acb (save-manifest .+)$/m,
      'bun run $1/packages/cli/bin/run.ts acb $2',
    );
  }

  const params = {
    pluginDir: '/plugin/root',
    workspaceRoot: '/workspace',
    nowIso: '2026-04-22T12:00:00+00:00',
  };

  test('Fixture A: feat/x, slug=None, diff present', () => {
    const sha = `${'abc'.repeat(13)}def`;
    const ts = generateManifestPrompt({
      ...params,
      branch: 'feat/x',
      sha,
      shortSha: sha.slice(0, 12),
      diffStat: ' src/auth.py | 10 ++++\n 1 file changed',
      slugClause: '',
      slugFlag: '',
    });
    const py = rewriteInvocation(readFileSync(join(CAPTURES_DIR, 'A.txt'), 'utf8'));
    expect(ts).toBe(py);
  });

  test('Fixture B: task/foo/1, slug=some-slug', () => {
    const sha = `${'def'.repeat(13)}abc`;
    const ts = generateManifestPrompt({
      ...params,
      branch: 'task/foo/1',
      sha,
      shortSha: sha.slice(0, 12),
      diffStat: ' README.md | 2 +-\n 1 file changed',
      slugClause: ' (run `some-slug`)',
      slugFlag: ' --slug some-slug',
    });
    const py = rewriteInvocation(readFileSync(join(CAPTURES_DIR, 'B.txt'), 'utf8'));
    expect(ts).toBe(py);
  });

  test('Fixture C: feature/y, slug=bar, multi-file diff', () => {
    const sha = `${'fff'.repeat(13)}aaa`;
    const ts = generateManifestPrompt({
      ...params,
      branch: 'feature/y',
      sha,
      shortSha: sha.slice(0, 12),
      diffStat: ' a.py | 1 +\n b.py | 1 +\n 2 files changed',
      slugClause: ' (run `bar`)',
      slugFlag: ' --slug bar',
    });
    const py = rewriteInvocation(readFileSync(join(CAPTURES_DIR, 'C.txt'), 'utf8'));
    expect(ts).toBe(py);
  });

  test('Fixture D: fix/z, slug=None, empty diff fallback', () => {
    const sha = `${'000'.repeat(13)}bbb`;
    const ts = generateManifestPrompt({
      ...params,
      branch: 'fix/z',
      sha,
      shortSha: sha.slice(0, 12),
      diffStat: '(no diff stat available)',
      slugClause: '',
      slugFlag: '',
    });
    const py = rewriteInvocation(readFileSync(join(CAPTURES_DIR, 'D.txt'), 'utf8'));
    expect(ts).toBe(py);
  });
});

// ---------------------------------------------------------------------------
// 6. Type sanity — ClaudeCodeHookPayload accepts loose shapes
// ---------------------------------------------------------------------------

describe('ClaudeCodeHookPayload shape', () => {
  test('extra fields are tolerated (unknown shape for tool_response)', () => {
    const payload: ClaudeCodeHookPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'git commit' },
      tool_response: { whatever: 'yes' },
    };
    // No assertion beyond compilation + call not throwing.
    const result = runHookPostCommit({ workspaceRoot: '/tmp/nope', payload });
    expect(typeof result.stdout).toBe('string');
  });
});
