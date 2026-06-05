/**
 * Filesystem layout resolver for a single `.prove/runs/<branch>/<slug>/` run.
 *
 * The on-disk names (root, prd, plan, state, state_lock, reports_dir) are
 * canonical: downstream hooks and stored run artifacts address these paths
 * by shape, so any drift here silently breaks them.
 */
import { join } from 'node:path';

/**
 * Branch names may contain `/` (git-flow style: `feat/login`), which would
 * nest the run directory deeper than the canonical two-level
 * `<runs_root>/<branch>/<slug>/` layout and hide the run from every
 * enumerator (hooks, ls, autodetect). The branch path component is
 * therefore percent-encoded (`%` → `%25` first, then `/` → `%2F`). Names
 * without those characters encode to themselves, so existing flat layouts
 * are untouched.
 */
export function encodeBranchDir(branch: string): string {
  return branch.replaceAll('%', '%25').replaceAll('/', '%2F');
}

/** Inverse of `encodeBranchDir` — maps an on-disk branch dir name back to
 *  the logical branch name. */
export function decodeBranchDir(dirName: string): string {
  return dirName.replaceAll('%2F', '/').replaceAll('%25', '%');
}

export interface RunPathsData {
  /** Absolute path to `<runs_root>/<branch>/<slug>/`. */
  root: string;
  /** `<root>/prd.json`. */
  prd: string;
  /** `<root>/plan.json`. */
  plan: string;
  /** `<root>/state.json` — the mutation hot path. */
  state: string;
  /** `<root>/state.json.lock` — presence-flag sidecar for the advisory lock. */
  state_lock: string;
  /** `<root>/reports/` — per-step completion reports. */
  reports_dir: string;
}

/**
 * Resolved filesystem layout for a single run.
 *
 * Mirrors the Python dataclass shape: attribute names match (`root`, `prd`,
 * `plan`, `state`, `state_lock`, `reports_dir`) and `RunPaths.forRun`
 * mirrors the Python classmethod `RunPaths.for_run`.
 */
export class RunPaths implements RunPathsData {
  readonly root: string;
  readonly prd: string;
  readonly plan: string;
  readonly state: string;
  readonly state_lock: string;
  readonly reports_dir: string;

  constructor(data: RunPathsData) {
    this.root = data.root;
    this.prd = data.prd;
    this.plan = data.plan;
    this.state = data.state;
    this.state_lock = data.state_lock;
    this.reports_dir = data.reports_dir;
  }

  /**
   * Canonical per-step report filename under `reports_dir`. Dots in step ids
   * are replaced with underscores so the filename is filesystem-safe; callers
   * must never derive this path independently — any change to the convention
   * here propagates automatically to every reader and writer.
   */
  reportFile(stepId: string): string {
    return join(this.reports_dir, `${stepId.replace(/\./g, '_')}.json`);
  }

  /**
   * Resolve layout for `<runs_root>/<branch>/<slug>/`. Does not touch the
   * filesystem — pure path computation. `initRun` creates the directory
   * structure. `branch` is the logical branch name; the dir component is
   * percent-encoded via `encodeBranchDir`, so callers holding an on-disk
   * dir name must `decodeBranchDir` it first or the `%` re-encodes.
   */
  static forRun(runsRoot: string, branch: string, slug: string): RunPaths {
    const root = join(runsRoot, encodeBranchDir(branch), slug);
    return new RunPaths({
      root,
      prd: join(root, 'prd.json'),
      plan: join(root, 'plan.json'),
      state: join(root, 'state.json'),
      state_lock: join(root, 'state.json.lock'),
      reports_dir: join(root, 'reports'),
    });
  }
}
