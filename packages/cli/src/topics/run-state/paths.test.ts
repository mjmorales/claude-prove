/**
 * RunPaths tests — pure path composition, no filesystem side effects.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { RunPaths, decodeBranchDir, encodeBranchDir } from './paths';

describe('RunPaths.forRun', () => {
  test('composes all six paths under <runs_root>/<branch>/<slug>/', () => {
    const paths = RunPaths.forRun('/tmp/runs', 'feature', 'demo');
    const root = join('/tmp/runs', 'feature', 'demo');
    expect(paths.root).toBe(root);
    expect(paths.prd).toBe(join(root, 'prd.json'));
    expect(paths.plan).toBe(join(root, 'plan.json'));
    expect(paths.state).toBe(join(root, 'state.json'));
    expect(paths.state_lock).toBe(join(root, 'state.json.lock'));
    expect(paths.reports_dir).toBe(join(root, 'reports'));
  });

  test('exports the Python dataclass attribute names', () => {
    const paths = RunPaths.forRun('/tmp/runs', 'feature', 'demo');
    // The Python side uses snake_case attributes: these must remain accessible
    // under the same names so cross-language callers share the shape.
    expect(paths).toHaveProperty('root');
    expect(paths).toHaveProperty('prd');
    expect(paths).toHaveProperty('plan');
    expect(paths).toHaveProperty('state');
    expect(paths).toHaveProperty('state_lock');
    expect(paths).toHaveProperty('reports_dir');
  });

  test('does not touch the filesystem', () => {
    // Non-existent root is fine — forRun is pure.
    const paths = RunPaths.forRun('/this/does/not/exist', 'b', 's');
    expect(paths.root).toBe(join('/this/does/not/exist', 'b', 's'));
  });

  test('encodes slashed branch names into a flat dir component', () => {
    const paths = RunPaths.forRun('/tmp/runs', 'feat/login', 'demo');
    // A nested path would hide the run from every two-level enumerator.
    expect(paths.root).toBe(join('/tmp/runs', 'feat%2Flogin', 'demo'));
    expect(paths.state).toBe(join('/tmp/runs', 'feat%2Flogin', 'demo', 'state.json'));
  });
});

describe('encodeBranchDir / decodeBranchDir', () => {
  test('flat names encode to themselves', () => {
    expect(encodeBranchDir('main')).toBe('main');
    expect(encodeBranchDir('feature-x_1.2')).toBe('feature-x_1.2');
  });

  test('round-trips slashes and literal percents', () => {
    for (const branch of ['feat/login', 'a/b/c', '50%/done', 'odd%2Fname', '%25']) {
      const encoded = encodeBranchDir(branch);
      expect(encoded).not.toContain('/');
      expect(decodeBranchDir(encoded)).toBe(branch);
    }
  });

  test('encoding is unambiguous — distinct branches never collide', () => {
    // 'a/b' vs literal 'a%2Fb': % is escaped first, so the dir names differ.
    expect(encodeBranchDir('a/b')).toBe('a%2Fb');
    expect(encodeBranchDir('a%2Fb')).toBe('a%252Fb');
  });
});
