/**
 * Filesystem layout resolver for a single `.prove/runs/<branch>/<slug>/` run.
 *
 * Ported 1:1 from the `RunPaths` dataclass in `tools/run_state/state.py`.
 * On-disk field names (root, prd, plan, state, state_lock, reports_dir) match
 * the Python dataclass attribute names — downstream hooks and sibling Python
 * code in `tools/run_state/` read these paths by their canonical shape, so
 * any drift here silently breaks them during the cross-language cutover.
 */
import { join } from 'node:path';

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
   * Resolve layout for `<runs_root>/<branch>/<slug>/`. Does not touch the
   * filesystem — pure path computation. `initRun` creates the directory
   * structure.
   */
  static forRun(runsRoot: string, branch: string, slug: string): RunPaths {
    const root = join(runsRoot, branch, slug);
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
