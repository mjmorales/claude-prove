/**
 * Stable symlink chain for plugin-anchored file references.
 *
 * Two links cooperate so tracked artifacts never carry a machine path:
 *
 *   <project>/.claude/prove-plugin  ->  ~/.claude-prove/latest  ->  plugin dir
 *
 * Generated CLAUDE.md `@`-references hardcode the project-relative
 * `.claude/prove-plugin/...` form — Claude Code's importer ONLY loads
 * project-relative paths (env vars never expand; `~/...` and absolute
 * imports outside the project silently fail to load) but follows symlinks
 * transparently. The machine-global `~/.claude-prove/latest` hop is the
 * per-machine "variable": re-pointing it at a new plugin dir (claude-env
 * layout, plain install, dev checkout, version bump) fixes every project's
 * references at once without regenerating any of them.
 *
 * Both links are refreshed idempotently by `install init` / `local-env`
 * and by `claude-md generate`. The project link is gitignored — its target
 * embeds the user's home dir, so it is per-machine state like
 * `.claude/settings.local.json`.
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Directory prove owns in the user's home for machine-global state. */
export const STABLE_ROOT_DIR = '.claude-prove';

/** Symlink name pointing at the active plugin dir. */
export const STABLE_ROOT_LINK = 'latest';

/**
 * Project-relative path of the per-project bridge symlink — the form
 * generated `@`-references hardcode. Project-relative because that is the
 * only path shape the CLAUDE.md importer loads.
 */
export const PROJECT_LINK_REL = '.claude/prove-plugin';

/** Absolute path of the stable-root symlink on this machine. */
export function stableRootPath(): string {
  return join(homedir(), STABLE_ROOT_DIR, STABLE_ROOT_LINK);
}

/**
 * Point `~/.claude-prove/latest` at `pluginDir`.
 *
 * Atomic against concurrent readers: the new link is created under a
 * temp name and `rename(2)`d over the old one, so the path never dangles
 * mid-refresh. Idempotent — re-pointing at the same target is a no-op at
 * the filesystem level (the link is still swapped, content identical).
 *
 * Throws when `pluginDir` does not exist — a dangling stable root would
 * silently break every generated `@`-reference on this machine.
 */
export function ensureStableRoot(pluginDir: string): string {
  if (!existsSync(pluginDir)) {
    throw new Error(`ensureStableRoot: plugin dir does not exist: ${pluginDir}`);
  }
  const linkPath = stableRootPath();
  mkdirSync(join(homedir(), STABLE_ROOT_DIR), { recursive: true });

  // Refuse to clobber a non-symlink occupying the path — that is user data
  // we did not create; surface it instead of silently replacing it.
  try {
    const st = lstatSync(linkPath);
    if (!st.isSymbolicLink()) {
      throw new Error(
        `ensureStableRoot: ${linkPath} exists and is not a symlink — move it aside and re-run`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const tmp = `${linkPath}.tmp.${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(pluginDir, tmp);
  renameSync(tmp, linkPath);
  return linkPath;
}

/**
 * Create/refresh `<projectRoot>/.claude/prove-plugin -> ~/.claude-prove/latest`
 * and make sure the project's `.gitignore` covers it.
 *
 * The link target is constant per machine (the stable root), so this never
 * needs re-pointing on plugin updates — only `ensureStableRoot` does. Same
 * atomicity and non-symlink-clobber rules as the stable root. The
 * `.gitignore` entry is appended only when missing (file created if absent):
 * the link embeds the user's home dir and must never be committed.
 */
export function ensureProjectLink(projectRoot: string): string {
  const linkPath = join(projectRoot, PROJECT_LINK_REL);
  mkdirSync(join(projectRoot, '.claude'), { recursive: true });

  try {
    const st = lstatSync(linkPath);
    if (!st.isSymbolicLink()) {
      throw new Error(
        `ensureProjectLink: ${linkPath} exists and is not a symlink — move it aside and re-run`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const tmp = `${linkPath}.tmp.${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(stableRootPath(), tmp);
  renameSync(tmp, linkPath);

  ensureGitignoreEntry(projectRoot);
  return linkPath;
}

/** Append the project-link path to `.gitignore` unless already covered. */
function ensureGitignoreEntry(projectRoot: string): void {
  const gitignorePath = join(projectRoot, '.gitignore');
  let content = '';
  try {
    content = readFileSync(gitignorePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    writeFileSync(gitignorePath, `${PROJECT_LINK_REL}\n`, 'utf8');
    return;
  }
  const lines = content.split('\n').map((l) => l.trim());
  if (lines.includes(PROJECT_LINK_REL) || lines.includes(`/${PROJECT_LINK_REL}`)) return;
  const sep = content.endsWith('\n') || content.length === 0 ? '' : '\n';
  appendFileSync(gitignorePath, `${sep}${PROJECT_LINK_REL}\n`, 'utf8');
}
