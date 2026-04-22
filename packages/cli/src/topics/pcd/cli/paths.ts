/**
 * Shared path helpers for the PCD CLI subcommands.
 *
 * Mirrors the private helpers in `tools/pcd/__main__.py`:
 *   _pcd_path(project_root)  -> `<root>/.prove/steward/pcd`
 *   _ensure_pcd_dir(...)     -> create + return the directory
 *
 * Every subcommand resolves `project_root` to an absolute path first
 * (`os.path.abspath`) so downstream artifact paths match Python byte-for-byte.
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PCD_DIR = join('.prove', 'steward', 'pcd');

/** Return the absolute path to the PCD artifact directory. */
export function pcdPath(projectRoot: string): string {
  return join(projectRoot, PCD_DIR);
}

/** Create the PCD artifact directory if missing and return its absolute path. */
export function ensurePcdDir(projectRoot: string): string {
  const path = pcdPath(projectRoot);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Resolve the user-supplied `--project-root` (default cwd) to an absolute path. */
export function resolveProjectRoot(flag: string | undefined): string {
  return resolve(flag ?? process.cwd());
}
