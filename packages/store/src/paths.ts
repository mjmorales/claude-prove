import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
 */
export function resolveDbPath(opts: ResolveOptions = {}): string {
  if (opts.override) return resolve(opts.override);
  const start = opts.cwd ?? process.cwd();
  const root = findGitRoot(start);
  return join(root, PROVE_DIR, DB_FILENAME);
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
