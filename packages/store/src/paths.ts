import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { upsert } from './project-registry';

export interface ResolveOptions {
  /** Starting directory for the git-root walk. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Explicit path that short-circuits git-root discovery. */
  override?: string;
}

const DB_FILENAME = 'prove.db';
const PROVE_DIR = '.prove';

/**
 * Resolve the prove.db path relative to the enclosing git repository.
 *
 * The returned path always ends in `<git-root>/.prove/prove.db`. When
 * `override` is provided, the path is resolved as an absolute path with no
 * git-root discovery. When the walk reaches the filesystem root without
 * finding `.git`, an error is thrown naming the original starting cwd so
 * callers can produce actionable messages.
 *
 * Side effect: the git-root branch records the resolved repository in the
 * machine-global project registry. This is the single choke point every store
 * consumer reaches (directly or via `openStore`), so registration rides the
 * resolution that already happens rather than threading a new call site
 * through each topic. The `override` branch is skipped — an explicit path is a
 * caller-supplied location with no git-root identity to register.
 */
export function resolveDbPath(opts: ResolveOptions = {}): string {
  if (opts.override) return resolve(opts.override);
  const start = opts.cwd ?? process.cwd();
  const root = findGitRoot(start);
  registerProjectRoot(root);
  return join(root, PROVE_DIR, DB_FILENAME);
}

/**
 * Record the resolved git root in the project registry, best-effort. The
 * registry's own new-or-stale gate keeps this cheap on the hot path (a fresh
 * entry triggers no write), and its worktree→main-root fold means a sub-task
 * worktree registers its main root. A registry failure must never break the
 * resolving command, so any throw is swallowed: registration is a convenience,
 * never a precondition for opening the store.
 */
function registerProjectRoot(root: string): void {
  try {
    upsert(root);
  } catch {
    // Best-effort: the registry is auxiliary state. Swallow and continue so a
    // corrupt or unwritable `~/.claude-prove/` never fails db resolution.
  }
}

function findGitRoot(start: string): string {
  let cur = resolve(start);
  while (true) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) {
      throw new Error(
        `no .git directory found walking upward from ${start}. @claude-prove/store must be invoked inside a git repository; pass an explicit { override } path to skip git-root discovery.`,
      );
    }
    cur = parent;
  }
}
